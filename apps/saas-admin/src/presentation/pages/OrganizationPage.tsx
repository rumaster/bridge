import { FormEvent, useEffect, useState } from "react";
import { Save } from "lucide-react";

import type {
  Organization,
  OrganizationConfiguration,
  ProblemDetails
} from "../../api/client/types";
import { hasAnyRole, useAuth } from "../../state/auth";
import { useSaasAdminApi } from "../../state/admin";
import { Badge, Button, Panel, TextAreaInput, TextInput } from "../../shared/ui-kit";
import { TimezoneSelect } from "../../shared/timezone-select";

interface OrganizationFormState {
  name: string;
  description: string;
  timezone: string;
  // Preserved for the update payload but not editable in the UI.
  locale: string;
  defaultLanguage: string;
  monthlyMessageLimit: string;
  notificationEmail: string;
  retentionDays: string;
}

type FieldErrors = Partial<Record<keyof OrganizationFormState, string>>;

// AI Assistant and Workflow automation are treated as always-on base
// functionality, so the UI no longer exposes toggles for them.
const AI_ASSISTANT_ALWAYS_ENABLED = true;
const WORKFLOW_AUTOMATION_ALWAYS_ENABLED = true;

const TIMEZONE_OPTIONS = [
  "UTC",
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "Europe/Kyiv",
  "Europe/Minsk",
  "Asia/Almaty",
  "Asia/Tashkent",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Shanghai",
  "Asia/Tokyo"
];

const DEFAULT_CONFIGURATION_FORM_STATE = {
  defaultLanguage: "ru",
  monthlyMessageLimit: "10000",
  notificationEmail: "",
  retentionDays: "90"
};

export default function OrganizationPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [configuration, setConfiguration] = useState<OrganizationConfiguration | null>(null);
  const [form, setForm] = useState<OrganizationFormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;

    if (!session || !canEdit) {
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
        if (active) {
          setOrganization(nextOrganization);
          setConfiguration(nextConfiguration);
          setForm(toFormState(nextOrganization, nextConfiguration));
          setAlert(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить организацию."));
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
  }, [api, canEdit, session]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session || !form) {
      return;
    }

    setSaving(true);
    setAlert(null);
    setSuccess(null);
    setFieldErrors({});

    try {
      const [nextOrganization, nextConfiguration] = await Promise.all([
        api.org.updateOrganization(session.organization.id, {
          name: form.name,
          description: form.description,
          timezone: form.timezone,
          locale: form.locale
        }),
        api.org.updateConfiguration(session.organization.id, {
          defaultLanguage: form.defaultLanguage,
          aiAssistantEnabled: AI_ASSISTANT_ALWAYS_ENABLED,
          workflowAutomationEnabled: WORKFLOW_AUTOMATION_ALWAYS_ENABLED,
          monthlyMessageLimit: Number(form.monthlyMessageLimit),
          notificationEmail: form.notificationEmail,
          retentionDays: Number(form.retentionDays)
        })
      ]);

      setOrganization(nextOrganization);
      setConfiguration(nextConfiguration);
      setForm(toFormState(nextOrganization, nextConfiguration));
      setSuccess("Изменения сохранены");
    } catch (error) {
      const problem = getProblemDetails(error);
      setAlert(problem?.detail ?? getProblemMessage(error, "Не удалось сохранить изменения."));
      setFieldErrors(toFieldErrors(problem));
    } finally {
      setSaving(false);
    }
  }

  function updateField<TKey extends keyof OrganizationFormState>(
    field: TKey,
    value: OrganizationFormState[TKey]
  ) {
    setForm((current) => (current ? { ...current, [field]: value } : current));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setSuccess(null);
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Организация</Badge>
        <h1>Организация и конфигурация</h1>
        <p>Параметры сохраняются через C3.org Backend API с серверной валидацией.</p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Редактор скрыт для текущей роли</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canEdit && form ? (
        <Panel as="form" className="organization-form" onSubmit={(event) => void handleSubmit(event)}>
          <fieldset disabled={saving || loading}>
            <legend>Основные сведения</legend>
            <div className="form-grid">
              <TextInput
                error={fieldErrors.name}
                label="Название организации"
                onChange={(event) => updateField("name", event.currentTarget.value)}
                required
                value={form.name}
              />
              <TimezoneSelect
                error={fieldErrors.timezone}
                label="Часовой пояс"
                onChange={(timezone) => updateField("timezone", timezone)}
                options={buildTimezoneOptions(form.timezone)}
                required
                value={form.timezone}
              />
              <TextAreaInput
                error={fieldErrors.description}
                label="Описание"
                onChange={(event) => updateField("description", event.currentTarget.value)}
                rows={4}
                value={form.description}
              />
            </div>
          </fieldset>

          <fieldset disabled={saving || loading}>
            <legend>Конфигурация</legend>
            <div className="form-grid">
              <TextInput
                error={fieldErrors.notificationEmail}
                label="Email уведомлений"
                onChange={(event) => updateField("notificationEmail", event.currentTarget.value)}
                required
                type="email"
                value={form.notificationEmail}
              />
              <TextInput
                error={fieldErrors.monthlyMessageLimit}
                label="Месячный лимит сообщений"
                min={100}
                onChange={(event) => updateField("monthlyMessageLimit", event.currentTarget.value)}
                required
                type="number"
                value={form.monthlyMessageLimit}
              />
              <TextInput
                error={fieldErrors.retentionDays}
                label="Хранение истории, дней"
                min={1}
                onChange={(event) => updateField("retentionDays", event.currentTarget.value)}
                required
                type="number"
                value={form.retentionDays}
              />
            </div>
          </fieldset>

          <div className="form-actions">
            <Button disabled={saving || loading} type="submit">
              <Save aria-hidden="true" size={16} />
              Сохранить изменения
            </Button>
            <span className="muted">
              Обновлено: {configuration?.updatedAt ?? organization?.updatedAt ?? "..."}
            </span>
          </div>
        </Panel>
      ) : null}

      {canEdit && loading ? <div className="route-loader">Загрузка организации...</div> : null}
    </section>
  );
}

function toFormState(
  organization: Organization,
  configuration: OrganizationConfiguration
): OrganizationFormState {
  return {
    name: organization.name,
    description: organization.description,
    timezone: organization.timezone,
    locale: organization.locale,
    defaultLanguage: configuration.defaultLanguage ?? DEFAULT_CONFIGURATION_FORM_STATE.defaultLanguage,
    monthlyMessageLimit:
      configuration.monthlyMessageLimit != null
        ? String(configuration.monthlyMessageLimit)
        : DEFAULT_CONFIGURATION_FORM_STATE.monthlyMessageLimit,
    notificationEmail:
      configuration.notificationEmail ?? DEFAULT_CONFIGURATION_FORM_STATE.notificationEmail,
    retentionDays:
      configuration.retentionDays != null
        ? String(configuration.retentionDays)
        : DEFAULT_CONFIGURATION_FORM_STATE.retentionDays
  };
}

function getProblemDetails(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "body" in error &&
    typeof (error as { body?: unknown }).body === "object" &&
    (error as { body?: unknown }).body !== null
  ) {
    return (error as { body: ProblemDetails }).body;
  }

  return null;
}

function toFieldErrors(problem: ProblemDetails | null): FieldErrors {
  if (!problem?.errors) {
    return {};
  }

  return problem.errors.reduce<FieldErrors>((errors, item) => {
    if (isOrganizationField(item.field)) {
      errors[item.field] = item.message;
    }

    return errors;
  }, {});
}

function isOrganizationField(field: string): field is keyof OrganizationFormState {
  return [
    "name",
    "description",
    "timezone",
    "locale",
    "defaultLanguage",
    "monthlyMessageLimit",
    "notificationEmail",
    "retentionDays"
  ].includes(field);
}

function buildTimezoneOptions(current: string) {
  if (current && !TIMEZONE_OPTIONS.includes(current)) {
    return [current, ...TIMEZONE_OPTIONS];
  }

  return TIMEZONE_OPTIONS;
}

function getProblemMessage(error: unknown, fallback: string) {
  const problem = getProblemDetails(error);
  if (problem) {
    return problem.detail;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}
