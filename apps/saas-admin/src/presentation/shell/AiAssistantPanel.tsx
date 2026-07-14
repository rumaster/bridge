import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Send,
  ShieldAlert,
  Sparkles,
  X
} from "lucide-react";

import type {
  OnboardingApplyResponse,
  OnboardingApplyResult,
  OnboardingCommand,
  OnboardingCommandAction,
  OnboardingCommandResponse,
  Organization,
  OrganizationConfiguration
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { Badge, Button, Panel, TextAreaInput } from "../../shared/ui-kit";
import { useAuth } from "../../state/auth";

/**
 * Степени раскрытия боковой AI-панели:
 * closed — свёрнута, у правого края видна только кнопка-язычок «<»;
 * half   — диалог с ассистентом поверх контента, контент остаётся доступен;
 * wide   — то же плюс сводка текущей конфигурации организации.
 */
export type AiPanelMode = "closed" | "half" | "wide";

type OpenAiPanelMode = Exclude<AiPanelMode, "closed">;

const PROMPT_SUGGESTIONS = [
  "Подними месячный лимит сообщений до 50000",
  "Включи AI-ассистента",
  "Отключи автоматизацию Workflow",
  'Переименуй организацию в «Северный ветер»'
];

type ConversationRole = "user" | "assistant" | "system";

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  text: string;
}

interface AiAssistantPanelProps {
  mode: OpenAiPanelMode;
  onModeChange: (mode: AiPanelMode) => void;
}

/**
 * Диалоговый помощник (ТЗ §16.8) формирует структурированную команду. После
 * подтверждения администратором Backend проверяет полномочия и применяет
 * изменения — панель отражает результат.
 *
 * Панель монтируется только в раскрытом состоянии, поэтому история диалога
 * живёт до закрытия: конфигурация перечитывается при каждом открытии и не
 * устаревает.
 */
export function AiAssistantPanel({ mode, onModeChange }: AiAssistantPanelProps) {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const messageSeq = useRef(0);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [configuration, setConfiguration] = useState<OrganizationConfiguration | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<OnboardingCommandResponse | null>(null);
  const [lastResult, setLastResult] = useState<OnboardingApplyResponse | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let active = true;

    if (!session) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    Promise.all([
      api.org.getOrganization(session.organization.id),
      api.org.getConfiguration(session.organization.id)
    ])
      .then(([nextOrganization, nextConfiguration]) => {
        if (!active) {
          return;
        }
        setOrganization(nextOrganization);
        setConfiguration(nextConfiguration);
        setAlert(null);
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить конфигурацию организации."));
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
  }, [api, session]);

  // Esc закрывает панель — привычный выход из наложенного слоя.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onModeChange("closed");
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onModeChange]);

  function appendMessage(role: ConversationRole, text: string) {
    messageSeq.current += 1;
    const id = `onboarding-msg-${messageSeq.current}`;
    setMessages((current) => [...current, { id, role, text }]);
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = prompt.trim();
    if (!trimmed) {
      setPromptError("Опишите изменение, которое нужно применить.");
      return;
    }

    setGenerating(true);
    setPromptError(null);
    setAlert(null);
    appendMessage("user", trimmed);

    try {
      const response = await api.onboarding.createCommand({ prompt: trimmed });
      appendMessage("assistant", response.assistant_message);
      setPendingCommand(response);
      setLastResult(null);
      setPrompt("");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось сформировать команду."));
    } finally {
      setGenerating(false);
    }
  }

  async function handleApply() {
    if (!pendingCommand) {
      return;
    }

    setApplying(true);
    setAlert(null);

    try {
      const response = await api.onboarding.applyCommand({ command: pendingCommand.command });
      setOrganization(response.organization);
      setConfiguration(response.configuration);
      setLastResult(response);
      setPendingCommand(null);
      appendMessage("system", describeApplyResult(response.result));
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось применить команду."));
    } finally {
      setApplying(false);
    }
  }

  function handleDiscard() {
    if (!pendingCommand) {
      return;
    }
    setPendingCommand(null);
    appendMessage("system", "Команда отклонена администратором. Изменения не применялись.");
  }

  const wide = mode === "wide";

  return (
    <aside aria-label="AI-ассистент" className={`ai-panel ai-panel--${mode}`} role="dialog">
      <div className="ai-panel-header">
        <div className="channel-title">
          <Bot aria-hidden="true" size={20} />
          <h2>AI-ассистент</h2>
        </div>
        <div className="ai-panel-controls">
          <button
            aria-label={wide ? "Сузить панель" : "Расширить панель"}
            className="ai-panel-control"
            onClick={() => onModeChange(wide ? "half" : "wide")}
            title={wide ? "Сузить панель" : "Расширить панель"}
            type="button"
          >
            {wide ? (
              <ChevronRight aria-hidden="true" size={16} />
            ) : (
              <ChevronLeft aria-hidden="true" size={16} />
            )}
          </button>
          <button
            aria-label="Закрыть панель AI-ассистента"
            className="ai-panel-control"
            onClick={() => onModeChange("closed")}
            title="Закрыть"
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </div>

      <div className="ai-panel-body">
        {alert ? (
          <div className="form-alert" role="alert">
            {alert}
          </div>
        ) : null}

        {loading ? <div className="route-loader">Загрузка конфигурации...</div> : null}

        <Panel aria-label="Диалог с AI-ассистентом" as="section" className="onboarding-dialog">
          <p className="muted">Опишите желаемое изменение конфигурации или организации.</p>

          <ol className="onboarding-thread" aria-label="История диалога">
            {messages.length === 0 ? (
              <li className="onboarding-empty muted">
                Начните диалог, например: «Подними месячный лимит до 50000».
              </li>
            ) : (
              messages.map((message) => (
                <li className={`onboarding-message ${message.role}`} key={message.id}>
                  <span className="onboarding-message-role">{roleLabel(message.role)}</span>
                  <span className="onboarding-message-text">{message.text}</span>
                </li>
              ))
            )}
          </ol>

          <form className="onboarding-form" onSubmit={(event) => void handleGenerate(event)}>
            <TextAreaInput
              error={promptError ?? undefined}
              id="onboarding-prompt"
              label="Опишите изменение"
              onChange={(event) => {
                setPrompt(event.currentTarget.value);
                setPromptError(null);
              }}
              placeholder="Например: включи AI-ассистента"
              rows={3}
              value={prompt}
            />
            <div className="onboarding-suggestions" aria-label="Подсказки">
              {PROMPT_SUGGESTIONS.map((suggestion) => (
                <button
                  className="onboarding-suggestion"
                  key={suggestion}
                  onClick={() => {
                    setPrompt(suggestion);
                    setPromptError(null);
                  }}
                  type="button"
                >
                  <Sparkles aria-hidden="true" size={12} />
                  {suggestion}
                </button>
              ))}
            </div>
            <Button disabled={generating} type="submit">
              <Send aria-hidden="true" size={16} />
              Сформировать команду
            </Button>
          </form>
        </Panel>

        {pendingCommand ? (
          <OnboardingCommandCard
            applying={applying}
            command={pendingCommand}
            onApply={() => void handleApply()}
            onDiscard={handleDiscard}
          />
        ) : null}

        {lastResult ? <OnboardingResultCard result={lastResult} /> : null}

        {/* Сводка конфигурации — только в широком режиме: в узком панель остаётся чатом. */}
        {wide ? (
          <OnboardingConfigurationPanel configuration={configuration} organization={organization} />
        ) : null}
      </div>
    </aside>
  );
}

interface OnboardingCommandCardProps {
  applying: boolean;
  command: OnboardingCommandResponse;
  onApply: () => void;
  onDiscard: () => void;
}

function OnboardingCommandCard({ applying, command, onApply, onDiscard }: OnboardingCommandCardProps) {
  const { command: structured, degraded, fallback_reason, summary } = command;

  return (
    <Panel aria-label="Подготовленная команда" as="section" className="onboarding-command">
      <div className="panel-heading-row">
        <div>
          <h3>Подготовленная команда</h3>
          <p>{summary}</p>
        </div>
        <Badge tone={degraded ? "warning" : "success"}>
          {degraded ? `Деградация: ${fallback_reason ?? "неизвестно"}` : "AI онлайн"}
        </Badge>
      </div>

      <dl className="metadata-list">
        <div>
          <dt>Действие</dt>
          <dd>{actionLabel(structured.action)}</dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>{generatedByLabel(structured.source.generated_by)}</dd>
        </div>
        <div>
          <dt>Идентификатор</dt>
          <dd>{structured.command_id}</dd>
        </div>
      </dl>

      <div className="onboarding-command-params">
        <span className="metric-label">Параметры команды</span>
        <pre>{JSON.stringify(structured.params, null, 2)}</pre>
      </div>

      <div className="onboarding-safety">
        <span className="onboarding-safety-title">
          <ShieldAlert aria-hidden="true" size={14} />
          Режим применения: {applyModeLabel(structured.safety.apply_mode)}
        </span>
        <ul>
          {structured.safety.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>

      <div className="form-actions">
        <Button disabled={applying} onClick={onApply} type="button">
          <CircleCheckBig aria-hidden="true" size={16} />
          Подтвердить и применить
        </Button>
        <Button disabled={applying} onClick={onDiscard} type="button" variant="ghost">
          Отклонить
        </Button>
      </div>
      <p className="muted onboarding-command-hint">
        Команда — лишь описание намерения. Полномочия и схему проверяет Backend (ТЗ §9.8, §12.6).
      </p>
    </Panel>
  );
}

interface OnboardingResultCardProps {
  result: OnboardingApplyResponse;
}

function OnboardingResultCard({ result }: OnboardingResultCardProps) {
  const applyResult = result.result;

  return (
    <Panel aria-label="Результат применения" as="section" className="onboarding-result">
      <div className="panel-heading-row">
        <div className="channel-title">
          <CircleCheckBig aria-hidden="true" size={20} />
          <div>
            <h3>Результат применения</h3>
            <p>{applyStatusLabel(applyResult.status)}</p>
          </div>
        </div>
        <Badge tone={applyStatusTone(applyResult.status)}>
          {applyResult.applied ? "Применено" : "Без изменений"}
        </Badge>
      </div>

      <dl className="metadata-list">
        <div>
          <dt>Действие</dt>
          <dd>{actionLabel(applyResult.action)}</dd>
        </div>
        <div>
          <dt>Применено</dt>
          <dd>{result.applied_at}</dd>
        </div>
      </dl>

      {Object.keys(applyResult.detail).length > 0 ? (
        <div className="onboarding-command-params">
          <span className="metric-label">Детали</span>
          <pre>{JSON.stringify(applyResult.detail, null, 2)}</pre>
        </div>
      ) : null}
    </Panel>
  );
}

interface OnboardingConfigurationPanelProps {
  configuration: OrganizationConfiguration | null;
  organization: Organization | null;
}

function OnboardingConfigurationPanel({
  configuration,
  organization
}: OnboardingConfigurationPanelProps) {
  return (
    <Panel aria-label="Текущая конфигурация" as="aside" className="onboarding-config">
      <h3>Текущая конфигурация</h3>
      <p className="muted">Панель отражает изменения после применения команды.</p>

      <dl className="metadata-list onboarding-config-list">
        <div>
          <dt>Организация</dt>
          <dd>{organization?.name ?? "—"}</dd>
        </div>
        <div>
          <dt>AI-ассистент</dt>
          <dd>
            <Badge tone={configuration?.aiAssistantEnabled === true ? "success" : "neutral"}>
              {enabledLabel(configuration?.aiAssistantEnabled, "Включен", "Отключен")}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Автоматизация Workflow</dt>
          <dd>
            <Badge tone={configuration?.workflowAutomationEnabled === true ? "success" : "neutral"}>
              {enabledLabel(configuration?.workflowAutomationEnabled, "Включена", "Отключена")}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Месячный лимит сообщений</dt>
          <dd>{formatOptionalNumber(configuration?.monthlyMessageLimit)}</dd>
        </div>
        <div>
          <dt>Язык по умолчанию</dt>
          <dd>{configuration?.defaultLanguage ?? "—"}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function enabledLabel(value: boolean | null | undefined, enabled: string, disabled: string) {
  if (value == null) {
    return "—";
  }

  return value ? enabled : disabled;
}

function formatOptionalNumber(value: number | null | undefined) {
  return typeof value === "number" ? value.toLocaleString("ru-RU") : "—";
}

function describeApplyResult(result: OnboardingApplyResult) {
  switch (result.status) {
    case "applied":
      return `Backend применил команду (${actionLabel(result.action)}). Конфигурация обновлена.`;
    case "not_supported":
      return `Backend отклонил команду: действие ${actionLabel(result.action)} не поддерживается на этапе M3.`;
    case "noop":
    default:
      return "Backend не нашёл изменений для применения.";
  }
}

function roleLabel(role: ConversationRole) {
  switch (role) {
    case "user":
      return "Вы";
    case "assistant":
      return "Ассистент";
    case "system":
    default:
      return "Система";
  }
}

function actionLabel(action: OnboardingCommandAction) {
  switch (action) {
    case "organization.update_profile":
      return "Обновление профиля организации";
    case "configuration.upsert":
      return "Изменение конфигурации";
    case "channel.connect":
      return "Подключение канала";
    case "user.invite":
      return "Приглашение пользователя";
    case "noop":
    default:
      return "Без изменений";
  }
}

function applyStatusLabel(status: OnboardingApplyResult["status"]) {
  switch (status) {
    case "applied":
      return "Изменения применены Backend.";
    case "not_supported":
      return "Действие не поддерживается на этапе M3.";
    case "noop":
    default:
      return "Изменений не потребовалось.";
  }
}

function applyStatusTone(status: OnboardingApplyResult["status"]): "success" | "warning" | "neutral" {
  switch (status) {
    case "applied":
      return "success";
    case "not_supported":
      return "warning";
    case "noop":
    default:
      return "neutral";
  }
}

function applyModeLabel(mode: OnboardingCommand["safety"]["apply_mode"]) {
  return mode === "backend_validation_required" ? "проверка на стороне Backend" : mode;
}

function generatedByLabel(generatedBy: OnboardingCommand["source"]["generated_by"]) {
  return generatedBy === "generated" ? "AI" : "Резервный сценарий";
}

function getProblemMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
