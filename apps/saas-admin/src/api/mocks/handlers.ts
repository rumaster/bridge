import { HttpResponse, http } from "msw";

import {
  createMockCapabilityDescriptor,
  mockChannels,
  mockConfiguration,
  mockKnowledgeDocuments,
  mockOrganization,
  mockSession
} from "./fixtures";
import type {
  AdminSession,
  Channel,
  ConnectChannelRequest,
  CreateKnowledgeDocumentRequest,
  KnowledgeDocument,
  Organization,
  OrganizationConfiguration,
  ProblemDetails,
  UpdateKnowledgeDocumentRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest
} from "../client/types";

const API_PREFIX = "*/api/v1";

let currentSession: AdminSession | null = null;
let currentOrganization: Organization = { ...mockOrganization };
let currentConfiguration: OrganizationConfiguration = { ...mockConfiguration };
let currentChannels: Channel[] = cloneChannels(mockChannels);
let currentDocuments: KnowledgeDocument[] = cloneDocuments(mockKnowledgeDocuments);
let nextChannelNumber = 1;
let nextDocumentNumber = 1;

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
  }),

  http.get(`${API_PREFIX}/channels`, () => {
    return HttpResponse.json(currentChannels.map(cloneChannel));
  }),

  http.post(`${API_PREFIX}/channels`, async ({ request }) => {
    const body = (await request.json()) as Partial<ConnectChannelRequest>;
    const errors = validateConnectChannel(body);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C3.channels DTO.");
    }

    const createdAt = "2026-07-03T10:20:00.000Z";
    const channel: Channel = {
      id: `channel-web-chat-created-${nextChannelNumber++}`,
      organization_id: body.organization_id ?? mockOrganization.id,
      channel_type: "web_chat",
      name: body.name?.trim() ?? "",
      status: "connected",
      ...(body.credentials_ref?.trim() ? { credentials_ref: body.credentials_ref.trim() } : {}),
      config: body.config ?? {},
      last_check_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
      error_log: []
    };

    currentChannels = [...currentChannels, channel];
    return HttpResponse.json({ channel: cloneChannel(channel) }, { status: 201 });
  }),

  http.get(`${API_PREFIX}/channels/:channelId/capabilities`, ({ params }) => {
    const channel = currentChannels.find((item) => item.id === params.channelId);
    if (!channel) {
      return problem(404, "Not Found", "Channel not found.");
    }

    return HttpResponse.json(createMockCapabilityDescriptor(channel));
  }),

  http.post(/\/api\/v1\/channels\/([^/]+):test$/, ({ request }) => {
    const channelId = getLastPathMatch(request.url, /\/channels\/([^/]+):test$/);
    const channel = currentChannels.find((item) => item.id === channelId);
    if (!channel) {
      return problem(404, "Not Found", "Channel not found.");
    }

    const checkedAt = "2026-07-03T10:25:00.000Z";
    currentChannels = currentChannels.map((item) =>
      item.id === channelId
        ? {
            ...item,
            status: "connected",
            last_check_at: checkedAt,
            updated_at: checkedAt
          }
        : item
    );

    return HttpResponse.json({
      accepted: true,
      channel_id: channelId,
      status: "connected",
      checked_at: checkedAt
    });
  }),

  http.get(`${API_PREFIX}/knowledge/documents`, () => {
    return HttpResponse.json(currentDocuments.map(cloneKnowledgeDocument));
  }),

  http.post(`${API_PREFIX}/knowledge/documents`, async ({ request }) => {
    const body = (await request.json()) as Partial<CreateKnowledgeDocumentRequest>;
    const errors = validateKnowledgeDocument(body);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C3.kb document DTO.");
    }

    const createdAt = "2026-07-03T10:30:00.000Z";
    const document: KnowledgeDocument = {
      id: `kb-doc-created-${nextDocumentNumber++}`,
      organization_id: body.organization_id ?? mockOrganization.id,
      title: body.title?.trim() ?? "",
      source: body.source?.trim() || null,
      status: "indexing",
      indexed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
      file_name: body.file_name,
      content_type: body.content_type,
      size_bytes: body.size_bytes
    };

    currentDocuments = [document, ...currentDocuments];
    return HttpResponse.json(cloneKnowledgeDocument(document), { status: 201 });
  }),

  http.post(/\/api\/v1\/knowledge\/documents\/([^/]+):reindex$/, ({ request }) => {
    const documentId = getLastPathMatch(request.url, /\/knowledge\/documents\/([^/]+):reindex$/);
    const document = currentDocuments.find((item) => item.id === documentId);
    if (!document) {
      return problem(404, "Not Found", "Knowledge document not found.");
    }

    const queuedAt = "2026-07-03T10:35:00.000Z";
    currentDocuments = currentDocuments.map((item) =>
      item.id === documentId
        ? {
            ...item,
            status: "indexing",
            indexed_at: null,
            updated_at: queuedAt,
            error_message: undefined
          }
        : item
    );

    return HttpResponse.json({
      accepted: true,
      document_id: documentId,
      status: "indexing",
      queued_at: queuedAt
    });
  }),

  http.patch(`${API_PREFIX}/knowledge/documents/:documentId`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<UpdateKnowledgeDocumentRequest>;
    const errors = validateKnowledgeDocument(body);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C3.kb document DTO.");
    }

    const document = currentDocuments.find((item) => item.id === params.documentId);
    if (!document) {
      return problem(404, "Not Found", "Knowledge document not found.");
    }

    const updated: KnowledgeDocument = {
      ...document,
      title: body.title?.trim() ?? document.title,
      source: body.source?.trim() || null,
      updated_at: "2026-07-03T10:32:00.000Z"
    };
    currentDocuments = currentDocuments.map((item) => (item.id === updated.id ? updated : item));

    return HttpResponse.json(cloneKnowledgeDocument(updated));
  }),

  http.delete(`${API_PREFIX}/knowledge/documents/:documentId`, ({ params }) => {
    const document = currentDocuments.find((item) => item.id === params.documentId);
    if (!document) {
      return problem(404, "Not Found", "Knowledge document not found.");
    }

    currentDocuments = currentDocuments.filter((item) => item.id !== params.documentId);
    return HttpResponse.json({
      deleted: true,
      document_id: document.id
    });
  })
];

export function resetMockBackendState() {
  currentSession = null;
  currentOrganization = { ...mockOrganization };
  currentConfiguration = { ...mockConfiguration };
  currentChannels = cloneChannels(mockChannels);
  currentDocuments = cloneDocuments(mockKnowledgeDocuments);
  nextChannelNumber = 1;
  nextDocumentNumber = 1;
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

function validateConnectChannel(input: Partial<ConnectChannelRequest>) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!input.organization_id) {
    errors.push({ field: "organization_id", message: "organization_id is required" });
  }

  if (input.channel_type !== "web_chat") {
    errors.push({ field: "channel_type", message: "Для M2 поддержан только web_chat." });
  }

  if (!input.name || input.name.trim().length < 2) {
    errors.push({ field: "name", message: "Название канала должно содержать минимум 2 символа." });
  }

  if (input.config && hasInlineSecret(input.config)) {
    errors.push({
      field: "config",
      message: "Секреты канала должны передаваться только как credentials_ref."
    });
  }

  return errors;
}

function validateKnowledgeDocument(
  input: Partial<CreateKnowledgeDocumentRequest | UpdateKnowledgeDocumentRequest>
) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!input.title || input.title.trim().length < 2) {
    errors.push({ field: "title", message: "Название документа должно содержать минимум 2 символа." });
  }

  return errors;
}

function hasInlineSecret(config: Record<string, unknown>) {
  const secretKeys = new Set([
    "api_key",
    "access_key",
    "client_secret",
    "password",
    "refresh_token",
    "secret",
    "token",
    "access_token"
  ]);

  return Object.keys(config).some((key) => secretKeys.has(key));
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

function getLastPathMatch(url: string, pattern: RegExp) {
  return new URL(url).pathname.match(pattern)?.[1] ?? "";
}

function cloneChannels(channels: Channel[]) {
  return channels.map(cloneChannel);
}

function cloneDocuments(documents: KnowledgeDocument[]) {
  return documents.map(cloneKnowledgeDocument);
}

function cloneChannel(channel: Channel): Channel {
  return {
    ...channel,
    config: { ...channel.config },
    error_log: channel.error_log?.map((item) => ({ ...item }))
  };
}

function cloneKnowledgeDocument(document: KnowledgeDocument): KnowledgeDocument {
  return { ...document };
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
