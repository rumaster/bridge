import { FormEvent, useEffect, useMemo, useState } from "react";
import { BarChart3, Plus, RadioTower, Send } from "lucide-react";

import type {
  BroadcastCampaign,
  BroadcastStartMode,
  BroadcastStats,
  C7Event,
  CreateBroadcastRequest,
  ProblemDetails
} from "../../api/client/types";
import { useC7RealtimeClient, useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import {
  BROADCAST_FILTER_MODES,
  BROADCAST_RATE_LIMIT_STRATEGIES,
  BROADCAST_START_MODES,
  broadcastDeliveryRate,
  broadcastFilterModeLabel,
  broadcastRateLimitStrategyLabel,
  broadcastStartModeLabel,
  broadcastStatusLabel,
  broadcastStatusTone,
  initialBroadcastFormState,
  splitList,
  validateBroadcastForm,
  type BroadcastFormErrors,
  type BroadcastFormState
} from "../../shared/broadcast";
import { Badge, Button, Panel, TextAreaInput, TextInput } from "../../shared/ui-kit";

type BroadcastStateChangedEvent = Extract<C7Event, { type: "broadcast.state_changed" }>;

interface StartControlState {
  mode: BroadcastStartMode;
  scheduledFor: string;
}

const initialStartControl: StartControlState = {
  mode: "immediate",
  scheduledFor: ""
};

export default function BroadcastPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const realtime = useC7RealtimeClient();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [broadcasts, setBroadcasts] = useState<BroadcastCampaign[]>([]);
  const [stats, setStats] = useState<Record<string, BroadcastStats>>({});
  const [form, setForm] = useState<BroadcastFormState>(initialBroadcastFormState);
  const [fieldErrors, setFieldErrors] = useState<BroadcastFormErrors>({});
  const [startControls, setStartControls] = useState<Record<string, StartControlState>>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState("offline");

  useEffect(() => {
    let active = true;

    if (!session || !canEdit) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    api.broadcasts
      .listBroadcasts()
      .then(async (response) => {
        const initialEvents = await realtime.collectInitialEvents().catch(() => []);
        const nextBroadcasts = applyBroadcastEvents(response.items, initialEvents);
        const nextStats = await loadStats(api, nextBroadcasts);
        if (active) {
          setBroadcasts(nextBroadcasts);
          setStats(applyStatsFromEvents(nextStats, initialEvents));
          setAlert(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить кампании Broadcast."));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, canEdit, realtime, session]);

  useEffect(() => {
    if (!canEdit) {
      return undefined;
    }

    const connection = realtime.connect(
      (event) => {
        if (event.type === "broadcast.state_changed") {
          setBroadcasts((current) => applyBroadcastEvent(current, event));
          if (event.payload.stats) {
            setStats((current) => ({ ...current, [event.payload.broadcastId]: event.payload.stats! }));
          }
        }
      },
      (status) => setRealtimeStatus(status)
    );

    return () => connection.close();
  }, [canEdit, realtime]);

  const summary = useMemo(() => {
    const running = broadcasts.filter((item) => item.status === "running").length;
    const scheduled = broadcasts.filter((item) => item.status === "scheduled").length;
    return { total: broadcasts.length, running, scheduled };
  }, [broadcasts]);

  function updateField<TKey extends keyof BroadcastFormState>(
    field: TKey,
    value: BroadcastFormState[TKey]
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setSuccess(null);
  }

  function startControlFor(broadcastId: string): StartControlState {
    return startControls[broadcastId] ?? initialStartControl;
  }

  function updateStartControl(broadcastId: string, patch: Partial<StartControlState>) {
    setStartControls((current) => ({
      ...current,
      [broadcastId]: { ...startControlFor(broadcastId), ...patch }
    }));
  }

  async function handleCreateBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const errors = validateBroadcastForm(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setAlert("Проверьте параметры черновика кампании.");
      return;
    }

    setSaving(true);
    setAlert(null);
    setSuccess(null);
    setFieldErrors({});

    try {
      const request: CreateBroadcastRequest = {
        organization_id: session.organization.id,
        created_by: session.user.displayName,
        name: form.name.trim(),
        template: {
          type: "text",
          body: form.body.trim(),
          locale: form.locale.trim() || undefined,
          variables: splitList(form.variables)
        },
        filter: {
          mode: form.filterMode,
          ...(splitList(form.channels).length > 0 ? { channels: splitList(form.channels) } : {}),
          ...(form.filterMode === "tags" ? { tags: splitList(form.tags) } : {})
        },
        schedule: { mode: "manual" },
        rate_limit: {
          messages_per_minute: Number(form.ratePerMinute),
          ...(form.burst.trim() ? { burst: Number(form.burst) } : {}),
          strategy: form.strategy
        }
      };

      const response = await api.broadcasts.createBroadcast(request);
      setBroadcasts((current) => [response.broadcast, ...current]);
      setStats((current) => ({
        ...current,
        [response.broadcast.id]: {
          prepared: 0,
          sent: 0,
          delivered: 0,
          failed: 0,
          updated_at: response.broadcast.updated_at
        }
      }));
      setForm(initialBroadcastFormState);
      setSuccess(`Черновик кампании «${response.broadcast.name}» создан`);
    } catch (error) {
      const problem = getProblemDetails(error);
      setFieldErrors(toBroadcastFieldErrors(problem));
      setAlert(problem?.detail ?? getProblemMessage(error, "Не удалось создать кампанию."));
    } finally {
      setSaving(false);
    }
  }

  async function handleStartBroadcast(broadcast: BroadcastCampaign) {
    if (!session) {
      return;
    }

    const control = startControlFor(broadcast.id);
    if (control.mode === "scheduled" && !control.scheduledFor.trim()) {
      setAlert("Для запуска по расписанию укажите дату и время.");
      return;
    }

    setStartingId(broadcast.id);
    setAlert(null);
    setSuccess(null);

    try {
      const response = await api.broadcasts.startBroadcast(broadcast.id, {
        organization_id: session.organization.id,
        started_by: session.user.displayName,
        mode: control.mode,
        ...(control.mode === "scheduled"
          ? { scheduled_for: new Date(control.scheduledFor).toISOString() }
          : {})
      });

      setBroadcasts((current) =>
        current.map((item) => (item.id === broadcast.id ? response.broadcast : item))
      );
      const freshStats = await api.broadcasts.getStats(broadcast.id);
      setStats((current) => ({ ...current, [broadcast.id]: freshStats.stats }));
      setSuccess(
        control.mode === "immediate"
          ? `Кампания «${broadcast.name}» запущена`
          : `Кампания «${broadcast.name}» запланирована`
      );
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось запустить кампанию."));
    } finally {
      setStartingId(null);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Рассылки</Badge>
        <h1>Broadcast</h1>
        <p>Кампании управляются через фасад C8 (CP-6); realtime-статусы приходят из C7.</p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел доступен только администратору организации</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canEdit ? (
        <>
          <div className="summary-grid">
            <Panel className="summary-panel">
              <span className="metric-label">Всего кампаний</span>
              <strong>{summary.total}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Выполняются</span>
              <strong>{summary.running}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Запланированы</span>
              <strong>{summary.scheduled}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">C7</span>
              <strong>{getRealtimeStatusLabel(realtimeStatus)}</strong>
            </Panel>
          </div>

          <Panel as="form" onSubmit={(event) => void handleCreateBroadcast(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Черновик кампании</h2>
                <p>UI формирует только описание кампании; доставку выполняет SVC-BCAST (ТЗ §21.5).</p>
              </div>
              <Button disabled={saving} type="submit">
                <Plus aria-hidden="true" size={16} />
                Создать черновик
              </Button>
            </div>
            <div className="form-grid">
              <TextInput
                error={fieldErrors.name}
                id="broadcast-name"
                label="Название кампании"
                onChange={(event) => updateField("name", event.currentTarget.value)}
                value={form.name}
              />
              <TextInput
                id="broadcast-locale"
                label="Локаль сообщения"
                onChange={(event) => updateField("locale", event.currentTarget.value)}
                placeholder="ru"
                value={form.locale}
              />
            </div>
            <TextAreaInput
              error={fieldErrors.body}
              id="broadcast-body"
              label="Текст сообщения"
              onChange={(event) => updateField("body", event.currentTarget.value)}
              placeholder="Здравствуйте, {{name}}!"
              rows={3}
              value={form.body}
            />
            <TextInput
              id="broadcast-variables"
              label="Переменные шаблона (через запятую)"
              onChange={(event) => updateField("variables", event.currentTarget.value)}
              placeholder="name, promo_code"
              value={form.variables}
            />
            <div className="form-grid">
              <div className="text-input">
                <label htmlFor="broadcast-filter-mode">Фильтр получателей</label>
                <select
                  id="broadcast-filter-mode"
                  onChange={(event) =>
                    updateField("filterMode", event.currentTarget.value as BroadcastFormState["filterMode"])
                  }
                  value={form.filterMode}
                >
                  {BROADCAST_FILTER_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {broadcastFilterModeLabel(mode)}
                    </option>
                  ))}
                </select>
              </div>
              <TextInput
                id="broadcast-channels"
                label="Каналы (id через запятую)"
                onChange={(event) => updateField("channels", event.currentTarget.value)}
                placeholder="channel-web-chat-main"
                value={form.channels}
              />
            </div>
            {form.filterMode === "tags" ? (
              <TextInput
                error={fieldErrors.tags}
                id="broadcast-tags"
                label="Теги получателей (через запятую)"
                onChange={(event) => updateField("tags", event.currentTarget.value)}
                placeholder="vip, active"
                value={form.tags}
              />
            ) : null}
            <div className="form-grid">
              <TextInput
                error={fieldErrors.ratePerMinute}
                id="broadcast-rate"
                inputMode="numeric"
                label="Сообщений в минуту"
                onChange={(event) => updateField("ratePerMinute", event.currentTarget.value)}
                value={form.ratePerMinute}
              />
              <TextInput
                id="broadcast-burst"
                inputMode="numeric"
                label="Burst (необязательно)"
                onChange={(event) => updateField("burst", event.currentTarget.value)}
                value={form.burst}
              />
              <div className="text-input">
                <label htmlFor="broadcast-strategy">Стратегия лимита</label>
                <select
                  id="broadcast-strategy"
                  onChange={(event) =>
                    updateField("strategy", event.currentTarget.value as BroadcastFormState["strategy"])
                  }
                  value={form.strategy}
                >
                  {BROADCAST_RATE_LIMIT_STRATEGIES.map((strategy) => (
                    <option key={strategy} value={strategy}>
                      {broadcastRateLimitStrategyLabel(strategy)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Panel>

          {loading ? <div className="route-loader">Загрузка кампаний...</div> : null}

          <div className="broadcast-grid">
            {broadcasts.map((broadcast) => (
              <BroadcastCard
                broadcast={broadcast}
                key={broadcast.id}
                onModeChange={(mode) => updateStartControl(broadcast.id, { mode })}
                onScheduledForChange={(scheduledFor) =>
                  updateStartControl(broadcast.id, { scheduledFor })
                }
                onStart={() => void handleStartBroadcast(broadcast)}
                startControl={startControlFor(broadcast.id)}
                starting={startingId === broadcast.id}
                stats={stats[broadcast.id]}
              />
            ))}
          </div>

          {!loading && broadcasts.length === 0 ? (
            <Panel className="empty-state">
              <RadioTower aria-hidden="true" size={28} />
              <span>Пока нет кампаний. Создайте первый черновик выше.</span>
            </Panel>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

interface BroadcastCardProps {
  broadcast: BroadcastCampaign;
  onModeChange: (mode: BroadcastStartMode) => void;
  onScheduledForChange: (scheduledFor: string) => void;
  onStart: () => void;
  startControl: StartControlState;
  starting: boolean;
  stats?: BroadcastStats;
}

function BroadcastCard({
  broadcast,
  onModeChange,
  onScheduledForChange,
  onStart,
  startControl,
  starting,
  stats
}: BroadcastCardProps) {
  const canStart = broadcast.status === "draft" || broadcast.status === "scheduled";

  return (
    <Panel
      aria-label={`Кампания ${broadcast.name}`}
      as="article"
      className={`broadcast-card status-${broadcast.status}`}
    >
      <div className="panel-heading-row">
        <div className="broadcast-title">
          <RadioTower aria-hidden="true" size={22} />
          <div>
            <h2>{broadcast.name}</h2>
            <span className="muted">{broadcast.template.body}</span>
          </div>
        </div>
        <Badge tone={broadcastStatusTone(broadcast.status)}>
          {broadcastStatusLabel(broadcast.status)}
        </Badge>
      </div>

      <dl className="metadata-list">
        <div>
          <dt>Фильтр</dt>
          <dd>{broadcastFilterModeLabel(broadcast.filter.mode)}</dd>
        </div>
        <div>
          <dt>Лимит</dt>
          <dd>{broadcast.rate_limit.messages_per_minute} сообщ./мин</dd>
        </div>
        <div>
          <dt>Автор</dt>
          <dd>{broadcast.created_by}</dd>
        </div>
      </dl>

      <BroadcastStatsTable stats={stats} />

      {canStart ? (
        <div className="broadcast-start">
          <div className="text-input">
            <label htmlFor={`broadcast-start-mode-${broadcast.id}`}>Режим запуска</label>
            <select
              id={`broadcast-start-mode-${broadcast.id}`}
              onChange={(event) => onModeChange(event.currentTarget.value as BroadcastStartMode)}
              value={startControl.mode}
            >
              {BROADCAST_START_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {broadcastStartModeLabel(mode)}
                </option>
              ))}
            </select>
          </div>
          {startControl.mode === "scheduled" ? (
            <TextInput
              id={`broadcast-scheduled-for-${broadcast.id}`}
              label="Дата и время"
              onChange={(event) => onScheduledForChange(event.currentTarget.value)}
              type="datetime-local"
              value={startControl.scheduledFor}
            />
          ) : null}
          <div className="form-actions">
            <Button disabled={starting} onClick={onStart} type="button">
              <Send aria-hidden="true" size={16} />
              Запустить
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function BroadcastStatsTable({ stats }: { stats?: BroadcastStats }) {
  if (!stats) {
    return (
      <div className="broadcast-stats">
        <span className="muted">Статистика появится после запуска.</span>
      </div>
    );
  }

  const deliveryRate = broadcastDeliveryRate(stats.delivered, stats.sent);

  return (
    <table className="broadcast-stats" aria-label="Статистика доставки">
      <thead>
        <tr>
          <th scope="col">Подготовлено</th>
          <th scope="col">Отправлено</th>
          <th scope="col">Доставлено</th>
          <th scope="col">Ошибки</th>
          <th scope="col">Доставляемость</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{stats.prepared}</td>
          <td>{stats.sent}</td>
          <td>{stats.delivered}</td>
          <td>{stats.failed}</td>
          <td>
            <span className="inline-status">
              <BarChart3 aria-hidden="true" size={14} />
              {deliveryRate}%
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

async function loadStats(api: ReturnType<typeof useSaasAdminApi>, broadcasts: BroadcastCampaign[]) {
  const entries = await Promise.all(
    broadcasts.map(async (broadcast) => {
      try {
        const response = await api.broadcasts.getStats(broadcast.id);
        return [broadcast.id, response.stats] as const;
      } catch {
        return null;
      }
    })
  );

  return Object.fromEntries(entries.filter(Boolean) as Array<[string, BroadcastStats]>);
}

function applyBroadcastEvent(broadcasts: BroadcastCampaign[], event: BroadcastStateChangedEvent) {
  return broadcasts.map((broadcast) =>
    broadcast.id === event.payload.broadcastId
      ? { ...broadcast, status: event.payload.status }
      : broadcast
  );
}

function applyBroadcastEvents(broadcasts: BroadcastCampaign[], events: C7Event[]) {
  return events.reduce(
    (current, event) =>
      event.type === "broadcast.state_changed" ? applyBroadcastEvent(current, event) : current,
    broadcasts
  );
}

function applyStatsFromEvents(stats: Record<string, BroadcastStats>, events: C7Event[]) {
  return events.reduce((current, event) => {
    if (event.type === "broadcast.state_changed" && event.payload.stats) {
      return { ...current, [event.payload.broadcastId]: event.payload.stats };
    }
    return current;
  }, stats);
}

function getRealtimeStatusLabel(status: string) {
  switch (status) {
    case "connected":
      return "online";
    case "reconnecting":
      return "reconnect";
    default:
      return "offline";
  }
}

function toBroadcastFieldErrors(problem: ProblemDetails | null): BroadcastFormErrors {
  const errors: BroadcastFormErrors = {};

  for (const error of problem?.errors ?? []) {
    if (error.field === "name") {
      errors.name = error.message;
    }
    if (error.field === "template") {
      errors.body = error.message;
    }
    if (error.field === "rate_limit") {
      errors.ratePerMinute = error.message;
    }
  }

  return errors;
}

function getProblemDetails(error: unknown): ProblemDetails | null {
  const maybeError = error as { body?: ProblemDetails };
  return maybeError.body ?? null;
}

function getProblemMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
