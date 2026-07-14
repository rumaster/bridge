import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Mail,
  MessageCircle,
  PlugZap,
  Plus,
  Send
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type {
  C7Event,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelStatus,
  ConnectableChannelType,
  EmailChannelCredentials,
  ProblemDetails
} from "../../api/client/types";
import { useC7RealtimeClient, useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button, Panel, TextInput } from "../../shared/ui-kit";

interface ChannelFormState {
  channelType: ConnectableChannelType;
  name: string;
  credentialsRef: string;
  credentials: string;
  configValue: string;
  // Структурные email-креды (Этап E1): IMAP приём + SMTP отправка. Порты — строкой
  // в форме, парсятся в число при отправке.
  imapHost: string;
  imapPort: string;
  imapTls: boolean;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: string;
  smtpTls: boolean;
  smtpUsername: string;
  smtpPassword: string;
  fromEmail: string;
  fromName: string;
}

type ChannelFieldErrors = Partial<Record<keyof ChannelFormState, string>>;

const emptyEmailCredentials = {
  imapHost: "",
  imapPort: "993",
  imapTls: true,
  imapUsername: "",
  imapPassword: "",
  smtpHost: "",
  smtpPort: "587",
  smtpTls: true,
  smtpUsername: "",
  smtpPassword: "",
  fromEmail: "",
  fromName: ""
} as const;

const emptyChannelForm: ChannelFormState = {
  channelType: "web_chat",
  name: "",
  credentialsRef: "",
  credentials: "",
  configValue: "",
  ...emptyEmailCredentials
};

// Telegram-токен из @BotFather: <bot_id>:<секрет>.
const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
// Токен доступа бота MAX (наследие TamTam) — непрозрачная строка ≥20 символов.
const MAX_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ChannelConnector {
  type: ConnectableChannelType;
  label: string;
  heading: string;
  icon: LucideIcon;
  // "token" — бизнес вводит plaintext-секрет (шифруется на бэкенде);
  // "ref" — вводится ссылка credentials_ref на внешний секрет-менеджер;
  // "email" — структурные креды IMAP/SMTP (Этап E1).
  secretKind: "token" | "ref" | "email";
  secretLabel: string;
  credentialsPlaceholder: string;
  // Клиентская валидация plaintext-токена (для secretKind="token"): паттерн формата
  // и подсказка в ошибке. У каждого канала свой формат токена.
  tokenPattern?: RegExp;
  tokenHint?: string;
  configKey: string;
  configLabel: string;
  configPlaceholder: string;
  configKind: "url" | "email" | "text";
}

const channelConnectors = [
  {
    type: "web_chat",
    label: "Web Chat",
    heading: "Подключение Web Chat",
    icon: MessageCircle,
    secretKind: "ref",
    secretLabel: "credentials_ref",
    credentialsPlaceholder: "secret://web-chat/org-demo/main",
    configKey: "widget_origin",
    configLabel: "Widget origin",
    configPlaceholder: "https://example.test",
    configKind: "url"
  },
  {
    type: "telegram",
    label: "Telegram",
    heading: "Подключение Telegram",
    icon: Send,
    secretKind: "token",
    secretLabel: "Токен бота",
    credentialsPlaceholder: "123456789:AA…токен из @BotFather",
    tokenPattern: TELEGRAM_TOKEN_PATTERN,
    tokenHint: "Формат токена: <bot_id>:<секрет> из @BotFather.",
    configKey: "bot_username",
    configLabel: "Bot username",
    configPlaceholder: "bridge_support_bot",
    configKind: "text"
  },
  {
    type: "max",
    label: "MAX",
    heading: "Подключение MAX",
    icon: Bot,
    secretKind: "token",
    secretLabel: "Токен бота",
    credentialsPlaceholder: "токен доступа бота MAX",
    tokenPattern: MAX_TOKEN_PATTERN,
    tokenHint: "Формат токена: строка доступа бота MAX (не короче 20 символов).",
    configKey: "bot_username",
    configLabel: "Bot username",
    configPlaceholder: "max_support_bot",
    configKind: "text"
  },
  {
    type: "email",
    label: "Email",
    heading: "Подключение Email",
    icon: Mail,
    secretKind: "email",
    secretLabel: "Креды IMAP/SMTP",
    credentialsPlaceholder: "",
    configKey: "from_email",
    configLabel: "From email",
    configPlaceholder: "support@example.test",
    configKind: "email"
  }
] as const satisfies readonly ChannelConnector[];

export default function ChannelsPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const realtime = useC7RealtimeClient();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ChannelCapabilityDescriptor>>({});
  const [form, setForm] = useState<ChannelFormState>(emptyChannelForm);
  const [fieldErrors, setFieldErrors] = useState<ChannelFieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [realtimeStatus, setRealtimeStatus] = useState("offline");
  const [mailLocalPart, setMailLocalPart] = useState("");
  const [mailOrdering, setMailOrdering] = useState(false);
  const [mailNotice, setMailNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let active = true;

    if (!session || !canEdit) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    api.channels
      .listChannels()
      .then(async (nextChannels) => {
        const initialEvents = await realtime.collectInitialEvents().catch(() => []);
        const channelsWithRealtimeStatus = applyChannelStatusEvents(nextChannels, initialEvents);
        const nextCapabilities = await loadCapabilities(api, channelsWithRealtimeStatus);
        if (active) {
          setChannels(channelsWithRealtimeStatus);
          setCapabilities(nextCapabilities);
          setAlert(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить каналы связи."));
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
        if (event.type === "channel.status_changed") {
          setChannels((current) => applyChannelStatusEvent(current, event));
        }
      },
      (status) => setRealtimeStatus(status)
    );

    return () => connection.close();
  }, [canEdit, realtime]);

  const summary = useMemo(() => {
    const connected = channels.filter((channel) => channel.status === "connected").length;
    return { connected, total: channels.length };
  }, [channels]);
  const selectedConnector = getChannelConnector(form.channelType);

  function updateField<TKey extends keyof ChannelFormState>(
    field: TKey,
    value: ChannelFormState[TKey]
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setSuccess(null);
  }

  function updateChannelType(channelType: ConnectableChannelType) {
    setForm((current) => ({
      ...current,
      channelType,
      credentialsRef: "",
      credentials: "",
      configValue: "",
      ...emptyEmailCredentials
    }));
    setFieldErrors({});
    setSuccess(null);
  }

  async function handleCreateChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const errors = validateChannelForm(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setAlert("Проверьте параметры подключения канала.");
      return;
    }

    setSaving(true);
    setAlert(null);
    setSuccess(null);
    setFieldErrors({});

    try {
      const connector = getChannelConnector(form.channelType);
      const secret =
        connector.secretKind === "token"
          ? { credentials: form.credentials.trim() }
          : connector.secretKind === "email"
            ? { email_credentials: buildEmailCredentials(form) }
            : form.credentialsRef.trim()
              ? { credentials_ref: form.credentialsRef.trim() }
              : {};
      const response = await api.channels.createChannel({
        organization_id: session.organization.id,
        channel_type: connector.type,
        name: form.name.trim(),
        ...secret,
        config: connector.secretKind === "email" ? {} : buildChannelConfig(connector, form.configValue)
      });
      const descriptor = await api.channels.getCapabilities(response.channel.id);

      setChannels((current) => [...current, response.channel]);
      setCapabilities((current) => ({ ...current, [response.channel.id]: descriptor }));
      setForm(emptyChannelForm);
      setSuccess(
        connector.secretKind === "token"
          ? `${connector.label} подключён — токен сохранён, проверьте подключение`
          : connector.secretKind === "email"
            ? `${connector.label} подключён — креды IMAP/SMTP сохранены, проверьте подключение`
            : `${connector.label} подключён через credentials_ref`
      );
    } catch (error) {
      const problem = getProblemDetails(error);
      setFieldErrors(toChannelFieldErrors(problem));
      setAlert(problem?.detail ?? getProblemMessage(error, "Не удалось подключить канал."));
    } finally {
      setSaving(false);
    }
  }

  async function handleOrderMailbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }
    const localPart = mailLocalPart.trim();
    if (!localPart || /[@\s]/.test(localPart)) {
      setMailNotice({ tone: "err", text: "Укажите имя ящика без @ и пробелов." });
      return;
    }
    setMailOrdering(true);
    setMailNotice(null);
    try {
      const result = await api.channels.orderMailbox({ local_part: localPart });
      setChannels((current) => [...current, result.channel]);
      setMailLocalPart("");
      setMailNotice({
        tone: "ok",
        text: `Ящик ${result.address} создан и подключён как канал Email.`,
      });
    } catch (error) {
      setMailNotice({ tone: "err", text: getProblemMessage(error, "Не удалось заказать ящик.") });
    } finally {
      setMailOrdering(false);
    }
  }

  async function handleTestChannel(channelId: string) {
    setTestingChannelId(channelId);
    setAlert(null);
    setTestMessages((current) => ({ ...current, [channelId]: "" }));

    try {
      const result = await api.channels.testChannel(channelId);
      setChannels((current) =>
        current.map((channel) =>
          channel.id === channelId
            ? {
                ...channel,
                status: result.status,
                last_check_at: result.checked_at,
                updated_at: result.checked_at,
                error_log: result.error ? [result.error, ...(channel.error_log ?? [])] : channel.error_log
              }
            : channel
        )
      );
      setTestMessages((current) => ({
        ...current,
        [channelId]: "Проверка подключения выполнена"
      }));
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось проверить канал."));
    } finally {
      setTestingChannelId(null);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Интеграции</Badge>
        <h1>Каналы связи</h1>
        <p>Каналы управляются через C3.channels; realtime-статусы приходят из C7.</p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел скрыт для текущей роли</h2>
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
          <div className="summary-grid m2-summary">
            <Panel className="summary-panel">
              <span className="metric-label">Всего каналов</span>
              <strong>{summary.total}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Подключены</span>
              <strong>{summary.connected}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">C7</span>
              <strong>{getRealtimeStatusLabel(realtimeStatus)}</strong>
            </Panel>
          </div>

          <Panel as="form" className="m2-form" onSubmit={(event) => void handleOrderMailbox(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Bridge Mail — заказать ящик</h2>
                <p>
                  Создаём почтовый ящик на нашем сервере и сразу подключаем его как канал Email —
                  креды вводить не нужно.
                </p>
              </div>
            </div>
            {mailNotice ? (
              mailNotice.tone === "ok" ? (
                <div className="form-success">{mailNotice.text}</div>
              ) : (
                <div className="form-alert" role="alert">
                  {mailNotice.text}
                </div>
              )
            ) : null}
            <TextInput
              id="bridge-mail-local-part"
              label="Имя ящика (до @)"
              onChange={(event) => setMailLocalPart(event.currentTarget.value)}
              placeholder="support"
              value={mailLocalPart}
            />
            <div className="form-actions">
              <Button disabled={mailOrdering} type="submit" variant="primary">
                {mailOrdering ? "Создаём…" : "Заказать ящик"}
              </Button>
            </div>
          </Panel>

          <Panel as="form" className="m2-form" onSubmit={(event) => void handleCreateChannel(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>{selectedConnector.heading}</h2>
                <p>
                  {selectedConnector.secretKind === "token"
                    ? "Токен бота организации шифруется на бэкенде и не хранится в открытом виде."
                    : selectedConnector.secretKind === "email"
                      ? "Креды IMAP/SMTP шифруются на бэкенде; пароли не отображаются после сохранения."
                      : "Секреты не вводятся как значения; хранится только ссылка credentials_ref."}
                </p>
              </div>
              <Button disabled={saving} type="submit">
                <Plus aria-hidden="true" size={16} />
                Подключить канал
              </Button>
            </div>
            <div className="form-grid">
              <fieldset className="channel-type-selector">
                <legend>Тип канала</legend>
                <div className="channel-type-options">
                  {channelConnectors.map((connector) => {
                    const Icon = connector.icon;

                    return (
                      <label className="channel-type-option" key={connector.type}>
                        <input
                          checked={form.channelType === connector.type}
                          name="channel-type"
                          onChange={() => updateChannelType(connector.type)}
                          type="radio"
                          value={connector.type}
                        />
                        <span>
                          <Icon aria-hidden="true" size={16} />
                          <span>{connector.label}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {fieldErrors.channelType ? (
                  <span className="field-error">{fieldErrors.channelType}</span>
                ) : null}
              </fieldset>
              <TextInput
                error={fieldErrors.name}
                id="channel-name"
                label="Название канала"
                onChange={(event) => updateField("name", event.currentTarget.value)}
                value={form.name}
              />
              {selectedConnector.secretKind === "token" ? (
                <TextInput
                  autoComplete="off"
                  error={fieldErrors.credentials}
                  id="channel-credentials-token"
                  label={selectedConnector.secretLabel}
                  onChange={(event) => updateField("credentials", event.currentTarget.value)}
                  placeholder={selectedConnector.credentialsPlaceholder}
                  type="password"
                  value={form.credentials}
                />
              ) : selectedConnector.secretKind === "email" ? (
                <EmailCredentialsFields errors={fieldErrors} form={form} onChange={updateField} />
              ) : (
                <TextInput
                  error={fieldErrors.credentialsRef}
                  id="channel-credentials-ref"
                  label={selectedConnector.secretLabel}
                  onChange={(event) => updateField("credentialsRef", event.currentTarget.value)}
                  placeholder={selectedConnector.credentialsPlaceholder}
                  value={form.credentialsRef}
                />
              )}
              {selectedConnector.secretKind === "email" ? null : (
                <TextInput
                  error={fieldErrors.configValue}
                  id={`channel-config-${selectedConnector.configKey}`}
                  label={selectedConnector.configLabel}
                  onChange={(event) => updateField("configValue", event.currentTarget.value)}
                  placeholder={selectedConnector.configPlaceholder}
                  value={form.configValue}
                />
              )}
            </div>
          </Panel>

          {loading ? <div className="route-loader">Загрузка каналов...</div> : null}

          <div className="channel-grid">
            {channels.map((channel) => (
              <ChannelCard
                capabilities={capabilities[channel.id]}
                channel={channel}
                key={channel.id}
                onTest={() => void handleTestChannel(channel.id)}
                testMessage={testMessages[channel.id]}
                testing={testingChannelId === channel.id}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface ChannelCardProps {
  capabilities?: ChannelCapabilityDescriptor;
  channel: Channel;
  onTest: () => void;
  testing: boolean;
  testMessage?: string;
}

function ChannelCard({ capabilities, channel, onTest, testing, testMessage }: ChannelCardProps) {
  const supportedCapabilities = Object.entries(capabilities?.capabilities ?? {})
    .filter(([, value]) => value.supported)
    .map(([name]) => name);
  const errors = channel.error_log ?? [];
  const identity = getChannelIdentity(channel);

  return (
    <Panel
      aria-label={`${channel.name} канал`}
      as="article"
      className={`channel-card status-${channel.status}`}
    >
      <div className="panel-heading-row">
        <div className="channel-title">
          {getChannelIcon(channel.status)}
          <div>
            <h2>{channel.name}</h2>
            <span className="muted">{getChannelTypeLabel(channel.channel_type)}</span>
          </div>
        </div>
        <Badge tone={getStatusTone(channel.status)}>{getStatusLabel(channel.status)}</Badge>
      </div>

      <dl className="metadata-list">
        <div>
          <dt>{identity.label}</dt>
          <dd>{identity.value}</dd>
        </div>
        <div>
          <dt>Последняя проверка</dt>
          <dd>{formatDate(channel.last_check_at)}</dd>
        </div>
      </dl>

      <div className="capability-list" aria-label={`Capabilities ${channel.name}`}>
        {supportedCapabilities.map((capability) => (
          <Badge key={capability} tone="neutral">
            {capability}
          </Badge>
        ))}
      </div>

      <div className="error-log">
        <h3>Журнал ошибок</h3>
        {errors.length > 0 ? (
          <ul>
            {errors.map((error) => (
              <li key={error.id}>
                <strong>{error.code}</strong>
                <span>{error.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">Ошибок нет</span>
        )}
      </div>

      <div className="form-actions">
        <Button disabled={testing} onClick={onTest} type="button" variant="secondary">
          <PlugZap aria-hidden="true" size={16} />
          Проверить подключение
        </Button>
        {testMessage ? <span className="inline-status">{testMessage}</span> : null}
      </div>
    </Panel>
  );
}

interface EmailCredentialsFieldsProps {
  form: ChannelFormState;
  errors: ChannelFieldErrors;
  onChange: <TKey extends keyof ChannelFormState>(field: TKey, value: ChannelFormState[TKey]) => void;
}

/** Структурная форма email-кред: IMAP (приём) + SMTP (отправка) + отправитель (E1). */
function EmailCredentialsFields({ form, errors, onChange }: EmailCredentialsFieldsProps) {
  return (
    <div className="email-credentials-form">
      <fieldset className="email-credentials">
        <legend>IMAP (приём)</legend>
        <TextInput
          error={errors.imapHost}
          id="email-imap-host"
          label="IMAP хост"
          onChange={(event) => onChange("imapHost", event.currentTarget.value)}
          placeholder="imap.example.com"
          value={form.imapHost}
        />
        <TextInput
          error={errors.imapPort}
          id="email-imap-port"
          label="IMAP порт"
          onChange={(event) => onChange("imapPort", event.currentTarget.value)}
          placeholder="993"
          type="number"
          value={form.imapPort}
        />
        <label className="checkbox-field">
          <input
            aria-label="IMAP: использовать TLS"
            checked={form.imapTls}
            onChange={(event) => onChange("imapTls", event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Использовать TLS</span>
        </label>
        <TextInput
          error={errors.imapUsername}
          id="email-imap-username"
          label="IMAP логин"
          onChange={(event) => onChange("imapUsername", event.currentTarget.value)}
          placeholder="support@example.com"
          value={form.imapUsername}
        />
        <TextInput
          autoComplete="off"
          error={errors.imapPassword}
          id="email-imap-password"
          label="IMAP пароль"
          onChange={(event) => onChange("imapPassword", event.currentTarget.value)}
          type="password"
          value={form.imapPassword}
        />
      </fieldset>
      <fieldset className="email-credentials">
        <legend>SMTP (отправка)</legend>
        <TextInput
          error={errors.smtpHost}
          id="email-smtp-host"
          label="SMTP хост"
          onChange={(event) => onChange("smtpHost", event.currentTarget.value)}
          placeholder="smtp.example.com"
          value={form.smtpHost}
        />
        <TextInput
          error={errors.smtpPort}
          id="email-smtp-port"
          label="SMTP порт"
          onChange={(event) => onChange("smtpPort", event.currentTarget.value)}
          placeholder="587"
          type="number"
          value={form.smtpPort}
        />
        <label className="checkbox-field">
          <input
            aria-label="SMTP: использовать TLS"
            checked={form.smtpTls}
            onChange={(event) => onChange("smtpTls", event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Использовать TLS</span>
        </label>
        <TextInput
          error={errors.smtpUsername}
          id="email-smtp-username"
          label="SMTP логин"
          onChange={(event) => onChange("smtpUsername", event.currentTarget.value)}
          placeholder="support@example.com"
          value={form.smtpUsername}
        />
        <TextInput
          autoComplete="off"
          error={errors.smtpPassword}
          id="email-smtp-password"
          label="SMTP пароль"
          onChange={(event) => onChange("smtpPassword", event.currentTarget.value)}
          type="password"
          value={form.smtpPassword}
        />
      </fieldset>
      <TextInput
        error={errors.fromEmail}
        id="email-from-email"
        label="From email"
        onChange={(event) => onChange("fromEmail", event.currentTarget.value)}
        placeholder="support@example.com"
        value={form.fromEmail}
      />
      <TextInput
        error={errors.fromName}
        id="email-from-name"
        label="Имя отправителя"
        onChange={(event) => onChange("fromName", event.currentTarget.value)}
        placeholder="Служба поддержки"
        value={form.fromName}
      />
    </div>
  );
}

function buildEmailCredentials(form: ChannelFormState): EmailChannelCredentials {
  const fromName = form.fromName.trim();

  return {
    imap: {
      host: form.imapHost.trim(),
      port: Number(form.imapPort),
      tls: form.imapTls,
      username: form.imapUsername.trim(),
      password: form.imapPassword
    },
    smtp: {
      host: form.smtpHost.trim(),
      port: Number(form.smtpPort),
      tls: form.smtpTls,
      username: form.smtpUsername.trim(),
      password: form.smtpPassword
    },
    from_email: form.fromEmail.trim(),
    ...(fromName ? { from_name: fromName } : {})
  };
}

function validateEmailCredentials(form: ChannelFormState): ChannelFieldErrors {
  const errors: ChannelFieldErrors = {};

  if (!form.imapHost.trim()) {
    errors.imapHost = "IMAP хост обязателен.";
  }
  if (!isValidPort(form.imapPort)) {
    errors.imapPort = "IMAP порт: число 1–65535.";
  }
  if (!form.imapUsername.trim()) {
    errors.imapUsername = "IMAP логин обязателен.";
  }
  if (!form.imapPassword) {
    errors.imapPassword = "IMAP пароль обязателен.";
  }
  if (!form.smtpHost.trim()) {
    errors.smtpHost = "SMTP хост обязателен.";
  }
  if (!isValidPort(form.smtpPort)) {
    errors.smtpPort = "SMTP порт: число 1–65535.";
  }
  if (!form.smtpUsername.trim()) {
    errors.smtpUsername = "SMTP логин обязателен.";
  }
  if (!form.smtpPassword) {
    errors.smtpPassword = "SMTP пароль обязателен.";
  }
  if (!EMAIL_PATTERN.test(form.fromEmail.trim())) {
    errors.fromEmail = "From email должен быть адресом email.";
  }

  return errors;
}

function isValidPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function loadCapabilities(api: ReturnType<typeof useSaasAdminApi>, channels: Channel[]) {
  const entries = await Promise.all(
    channels.map(async (channel) => {
      try {
        return [channel.id, await api.channels.getCapabilities(channel.id)] as const;
      } catch {
        return null;
      }
    })
  );

  return Object.fromEntries(entries.filter(Boolean) as Array<[string, ChannelCapabilityDescriptor]>);
}

type ChannelStatusEvent = Extract<C7Event, { type: "channel.status_changed" }>;

function applyChannelStatusEvent(channels: Channel[], event: ChannelStatusEvent) {
  return channels.map((channel) => {
    if (channel.id !== event.payload.channelId) {
      return channel;
    }

    return {
      ...channel,
      status: event.payload.status,
      last_check_at: event.payload.lastCheckAt ?? channel.last_check_at,
      updated_at: event.payload.lastCheckAt ?? channel.updated_at,
      error_log: event.payload.error ? prependChannelError(channel, event.payload.error) : channel.error_log
    };
  });
}

function applyChannelStatusEvents(channels: Channel[], events: C7Event[]) {
  return events.reduce(
    (currentChannels, event) =>
      event.type === "channel.status_changed"
        ? applyChannelStatusEvent(currentChannels, event)
        : currentChannels,
    channels
  );
}

function prependChannelError(channel: Channel, error: NonNullable<ChannelStatusEvent["payload"]["error"]>) {
  return [error, ...(channel.error_log ?? []).filter((item) => item.id !== error.id)];
}

function validateChannelForm(form: ChannelFormState): ChannelFieldErrors {
  const errors: ChannelFieldErrors = {};
  const connector = getChannelConnector(form.channelType);

  if (!form.name.trim()) {
    errors.name = "Название канала обязательно.";
  }

  if (connector.secretKind === "token") {
    const token = form.credentials.trim();
    if (!token) {
      errors.credentials = `${connector.secretLabel} обязателен.`;
    } else if (connector.tokenPattern && !connector.tokenPattern.test(token)) {
      errors.credentials = connector.tokenHint ?? "Неверный формат токена.";
    }
  } else if (connector.secretKind === "email") {
    Object.assign(errors, validateEmailCredentials(form));
  } else if (form.credentialsRef.trim() && !form.credentialsRef.trim().startsWith("secret://")) {
    errors.credentialsRef = "credentials_ref должен быть ссылкой secret://.";
  }

  const configValue = form.configValue.trim();
  if (configValue && connector.configKind === "url" && !/^https?:\/\//.test(configValue)) {
    errors.configValue = `${connector.configLabel} должен быть URL.`;
  }

  if (
    configValue &&
    connector.configKind === "email" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configValue)
  ) {
    errors.configValue = `${connector.configLabel} должен быть email.`;
  }

  return errors;
}

function getChannelConnector(type: ConnectableChannelType) {
  return channelConnectors.find((connector) => connector.type === type) ?? channelConnectors[0];
}

function buildChannelConfig(connector: ChannelConnector, configValue: string) {
  const value = configValue.trim();

  return value ? { [connector.configKey]: value } : {};
}

function getStatusLabel(status: ChannelStatus) {
  switch (status) {
    case "connected":
      return "Подключен";
    case "error":
      return "Ошибка";
    case "disabled":
      return "Отключен";
  }
}

function getStatusTone(status: ChannelStatus) {
  return status === "connected" ? "success" : "warning";
}

function getChannelIcon(status: ChannelStatus) {
  switch (status) {
    case "connected":
      return <CheckCircle2 aria-hidden="true" size={22} />;
    case "error":
      return <AlertTriangle aria-hidden="true" size={22} />;
    case "disabled":
      return <Clock3 aria-hidden="true" size={22} />;
  }
}

/**
 * Заголовок и значение информативной строки плитки в зависимости от типа канала.
 * credentials_ref не несёт смысла для бизнеса, поэтому показываем публичную
 * идентичность из config: bot_username (Telegram/MAX), widget_origin (Web Chat),
 * from_email + имя отправителя (Email). Значения кладёт бэкенд в channel.config.
 */
function getChannelIdentity(channel: Channel): { label: string; value: string } {
  const config = channel.config ?? {};
  const read = (key: string) => (typeof config[key] === "string" ? (config[key] as string).trim() : "");

  switch (channel.channel_type) {
    case "telegram":
    case "max": {
      const username = read("bot_username");
      return { label: "Bot username", value: username ? `@${username}` : "Не задан" };
    }
    case "web_chat": {
      const origin = read("widget_origin");
      return { label: "Widget origin", value: origin || "Не задан" };
    }
    case "email": {
      const fromEmail = read("from_email");
      const fromName = read("from_name");
      if (!fromEmail) {
        return { label: "От кого", value: "Не задан" };
      }
      return { label: "От кого", value: fromName ? `${fromName} <${fromEmail}>` : fromEmail };
    }
    default:
      return { label: "Идентификатор", value: "Не задан" };
  }
}

function getChannelTypeLabel(type: Channel["channel_type"]) {
  switch (type) {
    case "web_chat":
      return "Web Chat";
    case "telegram":
      return "Telegram";
    case "max":
      return "MAX";
    case "email":
      return "Email";
    default:
      return type;
  }
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

function formatDate(value: string | undefined) {
  return value ?? "Нет данных";
}

function toChannelFieldErrors(problem: ProblemDetails | null): ChannelFieldErrors {
  const errors: ChannelFieldErrors = {};

  for (const error of problem?.errors ?? []) {
    if (error.field === "name") {
      errors.name = error.message;
    }

    if (error.field === "credentials_ref") {
      errors.credentialsRef = error.message;
    }

    if (error.field === "credentials") {
      errors.credentials = error.message;
    }

    if (error.field === "config") {
      errors.configValue = error.message;
    }

    if (error.field === "channel_type") {
      errors.channelType = error.message;
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
