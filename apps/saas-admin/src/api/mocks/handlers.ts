import { HttpResponse, http } from "msw";

import { mockConfiguration, mockOrganization, mockSession } from "./fixtures";
import type {
  AdminSession,
  Organization,
  OrganizationConfiguration,
  ProblemDetails,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest
} from "../client/types";

const API_PREFIX = "*/api/v1";

let currentSession: AdminSession | null = null;
let currentOrganization: Organization = { ...mockOrganization };
let currentConfiguration: OrganizationConfiguration = { ...mockConfiguration };

export const handlers = [
  http.get(`${API_PREFIX}/auth/session`, () => {
    if (!currentSession) {
      return problem(401, "Unauthorized", "Authentication is required.");
    }

    return HttpResponse.json(currentSession);
  }),

  http.post(`${API_PREFIX}/auth/login/telegram/start`, async ({ request }) => {
    const body = (await request.json()) as { telegramUsername?: string };

    if (!body.telegramUsername) {
      return validationProblem(
        [
          {
            field: "telegramUsername",
            message: "telegramUsername is required"
          }
        ],
        "Request payload does not match C3.auth DTO."
      );
    }

    return HttpResponse.json(
      {
        status: "mock_code_delivery_scheduled",
        deliveryChannel: "telegram",
        telegramUsername: body.telegramUsername.replace(/^@/, "").toLowerCase(),
        expiresInSeconds: 300,
        implementationStage: "M1"
      },
      { status: 202 }
    );
  }),

  http.post(`${API_PREFIX}/auth/login/telegram/verify`, async ({ request }) => {
    const body = (await request.json()) as { telegramUsername?: string; code?: string };
    const errors: NonNullable<ProblemDetails["errors"]> = [];

    if (!body.telegramUsername) {
      errors.push({
        field: "telegramUsername",
        message: "telegramUsername is required"
      });
    }

    if (!body.code || !/^[0-9]{6}$/.test(body.code)) {
      errors.push({
        field: "code",
        message: "Telegram login code must contain exactly 6 digits."
      });
    }

    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C3.auth DTO.");
    }

    currentSession = { ...mockSession };
    return HttpResponse.json(currentSession);
  }),

  http.post(`${API_PREFIX}/auth/logout`, () => {
    currentSession = null;
    return HttpResponse.json({
      loggedOut: true,
      sessionMode: "mock",
      implementationStage: "M1"
    });
  }),

  http.get(`${API_PREFIX}/organizations/:organizationId`, ({ params }) => {
    if (params.organizationId !== currentOrganization.id) {
      return problem(404, "Not Found", "Organization not found.");
    }

    return HttpResponse.json(currentOrganization);
  }),

  http.patch(`${API_PREFIX}/organizations/:organizationId`, async ({ params, request }) => {
    if (params.organizationId !== currentOrganization.id) {
      return problem(404, "Not Found", "Organization not found.");
    }

    const body = (await request.json()) as Partial<UpdateOrganizationRequest>;
    const errors = validateOrganization(body);
    if (errors.length > 0) {
      return validationProblem(errors);
    }

    currentOrganization = {
      ...currentOrganization,
      name: body.name?.trim() ?? currentOrganization.name,
      description: body.description?.trim() ?? currentOrganization.description,
      timezone: body.timezone?.trim() ?? currentOrganization.timezone,
      locale: body.locale?.trim() ?? currentOrganization.locale,
      updatedAt: "2026-07-03T09:30:00.000Z"
    };

    return HttpResponse.json(currentOrganization);
  }),

  http.get(`${API_PREFIX}/organizations/:organizationId/configuration`, ({ params }) => {
    if (params.organizationId !== currentConfiguration.organizationId) {
      return problem(404, "Not Found", "Organization configuration not found.");
    }

    return HttpResponse.json(currentConfiguration);
  }),

  http.put(`${API_PREFIX}/organizations/:organizationId/configuration`, async ({ params, request }) => {
    if (params.organizationId !== currentConfiguration.organizationId) {
      return problem(404, "Not Found", "Organization configuration not found.");
    }

    const body = (await request.json()) as Partial<UpdateOrganizationConfigurationRequest>;
    const errors = validateConfiguration(body);
    if (errors.length > 0) {
      return validationProblem(errors);
    }

    currentConfiguration = {
      ...currentConfiguration,
      defaultLanguage: body.defaultLanguage?.trim() ?? currentConfiguration.defaultLanguage,
      aiAssistantEnabled: Boolean(body.aiAssistantEnabled),
      workflowAutomationEnabled: Boolean(body.workflowAutomationEnabled),
      monthlyMessageLimit: Number(body.monthlyMessageLimit),
      notificationEmail: body.notificationEmail?.trim() ?? currentConfiguration.notificationEmail,
      retentionDays: Number(body.retentionDays),
      updatedAt: "2026-07-03T09:31:00.000Z"
    };

    return HttpResponse.json(currentConfiguration);
  })
];

export function resetMockBackendState() {
  currentSession = null;
  currentOrganization = { ...mockOrganization };
  currentConfiguration = { ...mockConfiguration };
}

function validateOrganization(input: Partial<UpdateOrganizationRequest>) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!input.name || input.name.trim().length < 2) {
    errors.push({ field: "name", message: "Название организации должно содержать минимум 2 символа." });
  }

  if (!input.timezone || !input.timezone.includes("/")) {
    errors.push({ field: "timezone", message: "Часовой пояс должен быть IANA-идентификатором." });
  }

  if (!input.locale || !/^[a-z]{2}-[A-Z]{2}$/.test(input.locale)) {
    errors.push({ field: "locale", message: "Локаль должна быть в формате ru-RU." });
  }

  return errors;
}

function validateConfiguration(input: Partial<UpdateOrganizationConfigurationRequest>) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!input.defaultLanguage || !/^[a-z]{2}$/.test(input.defaultLanguage)) {
    errors.push({ field: "defaultLanguage", message: "Язык по умолчанию должен быть ISO-кодом из 2 букв." });
  }

  if (!Number.isInteger(input.monthlyMessageLimit) || Number(input.monthlyMessageLimit) < 100) {
    errors.push({ field: "monthlyMessageLimit", message: "Месячный лимит должен быть не меньше 100." });
  }

  if (!input.notificationEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.notificationEmail)) {
    errors.push({ field: "notificationEmail", message: "Email уведомлений должен быть корректным адресом." });
  }

  if (!Number.isInteger(input.retentionDays) || Number(input.retentionDays) < 1) {
    errors.push({ field: "retentionDays", message: "Срок хранения должен быть положительным числом дней." });
  }

  return errors;
}

function validationProblem(
  errors: NonNullable<ProblemDetails["errors"]>,
  detail = "Request payload does not match C3.org DTO."
) {
  return HttpResponse.json(
    {
      type: "https://bridge.local/problems/validation-error",
      title: "Validation failed",
      status: 400,
      detail,
      errors
    } satisfies ProblemDetails,
    { status: 400 }
  );
}

function problem(status: number, title: string, detail: string) {
  return HttpResponse.json(
    {
      type: `https://bridge.local/problems/${title.toLowerCase().replaceAll(" ", "-")}`,
      title,
      status,
      detail
    } satisfies ProblemDetails,
    { status }
  );
}
