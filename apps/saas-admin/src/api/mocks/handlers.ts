import { HttpResponse, http } from "msw";

import {
  applyOnboardingCommand,
  cloneBroadcast,
  cloneBroadcastFilter,
  cloneBroadcastStats,
  cloneBroadcastTemplate,
  cloneNotification,
  cloneNotificationSettings,
  cloneWorkflow,
  cloneWorkflowInstance,
  cloneWorkflowInstanceDetail,
  cloneWorkflowSchema,
  cloneWorkflowSubschema,
  cloneWorkflowVersion,
  createMockCapabilityDescriptor,
  deriveOnboardingCommand,
  mockBroadcasts,
  mockBroadcastStats,
  mockChannels,
  mockConfiguration,
  mockKnowledgeDocuments,
  mockNotifications,
  mockNotificationSettings,
  mockOrganization,
  mockSession,
  createMockSession,
  mockWorkflowInstanceLogs,
  mockWorkflowInstances,
  mockWorkflowSubschemas,
  mockWorkflowVersions,
  mockWorkflows
} from "./fixtures";
import type {
  AdminSession,
  BroadcastCampaign,
  BroadcastStats,
  BroadcastTemplate,
  Channel,
  ConnectChannelRequest,
  CreateBroadcastRequest,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowVersionRequest,
  KnowledgeDocument,
  Notification,
  NotificationSetting,
  OnboardingApplyRequest,
  OnboardingCommandRequest,
  Organization,
  OrganizationConfiguration,
  ProblemDetails,
  StartBroadcastRequest,
  UpdateKnowledgeDocumentRequest,
  UpdateNotificationSettingsRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowInstance,
  WorkflowSchema,
  WorkflowSubschema,
  WorkflowVersion
} from "../client/types";
import { validateWorkflowSchema } from "../../shared/workflow";

const API_PREFIX = "*/api/v1";
const CONNECTABLE_CHANNEL_TYPES = new Set(["web_chat", "telegram", "max", "email"]);

let currentSession: AdminSession | null = null;
let currentOrganization: Organization = { ...mockOrganization };
let currentConfiguration: OrganizationConfiguration = { ...mockConfiguration };
let currentChannels: Channel[] = cloneChannels(mockChannels);
let currentDocuments: KnowledgeDocument[] = cloneDocuments(mockKnowledgeDocuments);
let currentWorkflows: Workflow[] = mockWorkflows.map(cloneWorkflow);
let currentVersions: WorkflowVersion[] = mockWorkflowVersions.map(cloneWorkflowVersion);
let currentSubschemas: WorkflowSubschema[] = mockWorkflowSubschemas.map(cloneWorkflowSubschema);
let currentInstances: WorkflowInstance[] = mockWorkflowInstances.map(cloneWorkflowInstance);
let currentBroadcasts: BroadcastCampaign[] = mockBroadcasts.map(cloneBroadcast);
let currentBroadcastStats: Record<string, BroadcastStats> = cloneBroadcastStatsMap(mockBroadcastStats);
let currentNotifications: Notification[] = mockNotifications.map(cloneNotification);
let currentNotificationSettings: NotificationSetting[] =
  cloneNotificationSettings(mockNotificationSettings);
let nextChannelNumber = 1;
let nextDocumentNumber = 1;
let nextWorkflowVersionNumber = 1;
let nextOnboardingNumber = 1;
let nextConfigurationVersion = 2;
let nextBroadcastNumber = 1;

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

    currentSession = createSessionForTelegramUsername(body.telegramUsername);
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
    const channelType = body.channel_type ?? "web_chat";
    const channel: Channel = {
      id: `channel-${channelType.replace("_", "-")}-created-${nextChannelNumber++}`,
      organization_id: body.organization_id ?? mockOrganization.id,
      channel_type: channelType,
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
  }),

  http.get(`${API_PREFIX}/workflows`, () => {
    return HttpResponse.json(currentWorkflows.map(cloneWorkflow));
  }),

  http.get(`${API_PREFIX}/workflow-subschemas`, () => {
    return HttpResponse.json(currentSubschemas.map(cloneWorkflowSubschema));
  }),

  http.get(`${API_PREFIX}/workflows/:workflowId/versions`, ({ params }) => {
    if (!currentWorkflows.some((item) => item.id === params.workflowId)) {
      return problem(404, "Not Found", "Workflow not found.");
    }

    return HttpResponse.json(
      currentVersions
        .filter((version) => version.workflow_id === params.workflowId)
        .map(cloneWorkflowVersion)
    );
  }),

  http.post(`${API_PREFIX}/workflows/:workflowId/versions`, async ({ params, request }) => {
    const workflow = currentWorkflows.find((item) => item.id === params.workflowId);
    if (!workflow) {
      return problem(404, "Not Found", "Workflow not found.");
    }

    const body = (await request.json()) as Partial<CreateWorkflowVersionRequest>;
    const errors = validateWorkflowVersionPayload(body.schema);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C5 workflow version DTO.");
    }

    const versionNo =
      currentVersions
        .filter((version) => version.workflow_id === workflow.id)
        .reduce((max, version) => Math.max(max, version.version_no), 0) + 1;
    const version: WorkflowVersion = {
      id: `wfv-created-${nextWorkflowVersionNumber++}`,
      organization_id: workflow.organization_id,
      workflow_id: workflow.id,
      version_no: versionNo,
      schema: cloneWorkflowSchema(body.schema as WorkflowSchema),
      created_by: mockSession.user.displayName,
      created_at: "2026-07-03T11:15:00.000Z"
    };

    currentVersions = [...currentVersions, version];
    if (body.activate) {
      currentWorkflows = currentWorkflows.map((item) =>
        item.id === workflow.id
          ? {
              ...item,
              status: "active",
              default_version_id: version.id,
              updated_at: "2026-07-03T11:15:00.000Z"
            }
          : item
      );
    }

    return HttpResponse.json(cloneWorkflowVersion(version), { status: 201 });
  }),

  http.get(`${API_PREFIX}/workflows/:workflowId/instances/:instanceId`, ({ params }) => {
    const instance = currentInstances.find(
      (item) => item.id === params.instanceId && item.workflow_id === params.workflowId
    );
    if (!instance) {
      return problem(404, "Not Found", "Workflow instance not found.");
    }

    return HttpResponse.json(
      cloneWorkflowInstanceDetail({
        ...instance,
        logs: mockWorkflowInstanceLogs[instance.id] ?? []
      })
    );
  }),

  http.get(`${API_PREFIX}/workflows/:workflowId/instances`, ({ params }) => {
    if (!currentWorkflows.some((item) => item.id === params.workflowId)) {
      return problem(404, "Not Found", "Workflow not found.");
    }

    return HttpResponse.json(
      currentInstances
        .filter((instance) => instance.workflow_id === params.workflowId)
        .map(cloneWorkflowInstance)
    );
  }),

  http.patch(`${API_PREFIX}/workflows/:workflowId`, async ({ params, request }) => {
    const workflow = currentWorkflows.find((item) => item.id === params.workflowId);
    if (!workflow) {
      return problem(404, "Not Found", "Workflow not found.");
    }

    const body = (await request.json()) as Partial<UpdateWorkflowRequest>;
    if (
      body.default_version_id &&
      !currentVersions.some(
        (version) =>
          version.workflow_id === workflow.id && version.id === body.default_version_id
      )
    ) {
      return validationProblem(
        [{ field: "default_version_id", message: "Указанная версия не найдена." }],
        "Request payload does not match C5 workflow DTO."
      );
    }

    const updated: Workflow = {
      ...workflow,
      enabled: typeof body.enabled === "boolean" ? body.enabled : workflow.enabled,
      status: body.status ?? workflow.status,
      default_version_id: body.default_version_id ?? workflow.default_version_id,
      updated_at: "2026-07-03T11:16:00.000Z"
    };
    currentWorkflows = currentWorkflows.map((item) => (item.id === workflow.id ? updated : item));

    return HttpResponse.json(cloneWorkflow(updated));
  }),

  http.post(/\/api\/v1\/ai\/onboarding:command$/, async ({ request }) => {
    const body = (await request.json()) as Partial<OnboardingCommandRequest>;
    if (!body.prompt || !body.prompt.trim()) {
      return validationProblem(
        [{ field: "prompt", message: "Опишите, что нужно изменить." }],
        "Request payload does not match C4 onboarding DTO."
      );
    }

    const response = deriveOnboardingCommand(
      { prompt: body.prompt, request_id: body.request_id },
      {
        organizationId: currentOrganization.id,
        organization: currentOrganization,
        configuration: currentConfiguration
      },
      {
        requestId: body.request_id ?? `onboarding-req-${nextOnboardingNumber++}`,
        createdAt: "2026-07-03T11:00:00.000Z"
      }
    );

    return HttpResponse.json(response);
  }),

  http.post(/\/api\/v1\/ai\/onboarding:apply$/, async ({ request }) => {
    const body = (await request.json()) as Partial<OnboardingApplyRequest>;
    const command = body.command;
    if (!command) {
      return validationProblem(
        [{ field: "command", message: "Команда обязательна." }],
        "Request payload does not match C4 onboarding DTO."
      );
    }

    if (command.organization_id !== currentOrganization.id) {
      return problem(400, "Bad Request", "Command organization_id does not match the tenant.");
    }

    const { result, organization, configuration } = applyOnboardingCommand(
      command,
      {
        organizationId: currentOrganization.id,
        organization: currentOrganization,
        configuration: currentConfiguration
      },
      {
        appliedAt: "2026-07-03T11:00:05.000Z",
        configurationVersion: nextConfigurationVersion++
      }
    );

    currentOrganization = organization;
    currentConfiguration = configuration;

    return HttpResponse.json({
      contract: "C4.OnboardingApplyResponse",
      version: "1.0.0",
      request_id: command.command_id,
      organization_id: currentOrganization.id,
      result,
      configuration,
      organization,
      applied_at: "2026-07-03T11:00:05.000Z"
    });
  }),

  http.get(`${API_PREFIX}/broadcasts`, () => {
    return HttpResponse.json({
      contract: "C8.ListBroadcastsResponse",
      version: "1.0.0",
      request_id: "broadcast-list-req",
      organization_id: currentOrganization.id,
      items: currentBroadcasts.map(cloneBroadcast),
      page: {
        limit: 50,
        offset: 0,
        total: currentBroadcasts.length
      }
    });
  }),

  http.post(`${API_PREFIX}/broadcasts`, async ({ request }) => {
    const body = (await request.json()) as Partial<CreateBroadcastRequest>;
    const errors = validateCreateBroadcast(body);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C8.CreateBroadcastRequest DTO.");
    }

    const createdAt = "2026-07-03T12:00:00.000Z";
    const broadcast: BroadcastCampaign = {
      id: `broadcast-created-${nextBroadcastNumber++}`,
      organization_id: body.organization_id ?? mockOrganization.id,
      name: body.name!.trim(),
      status: "draft",
      template: cloneBroadcastTemplate(body.template as BroadcastTemplate),
      filter: cloneBroadcastFilter(body.filter ?? { mode: "all" }),
      schedule: { ...(body.schedule ?? { mode: "manual" }) },
      rate_limit: { ...(body.rate_limit ?? { messages_per_minute: 60 }) },
      created_by: body.created_by ?? mockSession.user.displayName,
      created_at: createdAt,
      updated_at: createdAt
    };

    currentBroadcasts = [broadcast, ...currentBroadcasts];
    currentBroadcastStats = {
      ...currentBroadcastStats,
      [broadcast.id]: { prepared: 0, sent: 0, delivered: 0, failed: 0, updated_at: createdAt }
    };

    return HttpResponse.json(
      {
        contract: "C8.CreateBroadcastResponse",
        version: "1.0.0",
        request_id: "broadcast-create-req",
        organization_id: broadcast.organization_id,
        broadcast: cloneBroadcast(broadcast)
      },
      { status: 201 }
    );
  }),

  http.post(/\/api\/v1\/broadcasts\/([^/]+):start$/, async ({ request }) => {
    const broadcastId = getLastPathMatch(request.url, /\/broadcasts\/([^/]+):start$/);
    const existing = currentBroadcasts.find((item) => item.id === broadcastId);
    if (!existing) {
      return problem(404, "Not Found", "Broadcast not found.");
    }

    const body = (await request.json()) as Partial<StartBroadcastRequest>;
    const errors = validateStartBroadcast(body);
    if (errors.length > 0) {
      return validationProblem(errors, "Request payload does not match C8.StartBroadcastRequest DTO.");
    }

    const startedAt = "2026-07-03T12:05:00.000Z";
    const nextStatus = body.mode === "scheduled" ? "scheduled" : "running";
    const updated: BroadcastCampaign = {
      ...cloneBroadcast(existing),
      status: nextStatus,
      schedule: {
        ...existing.schedule,
        mode: body.mode!,
        ...(body.scheduled_for ? { scheduled_for: body.scheduled_for } : {})
      },
      updated_at: startedAt
    };
    currentBroadcasts = currentBroadcasts.map((item) => (item.id === broadcastId ? updated : item));

    return HttpResponse.json({
      contract: "C8.StartBroadcastResponse",
      version: "1.0.0",
      request_id: "broadcast-start-req",
      organization_id: updated.organization_id,
      broadcast: cloneBroadcast(updated),
      degraded: false,
      fallback_reason: null,
      core_delivery_draft: {
        contract: "C8.CoreDeliveryDraft",
        broadcast_id: broadcastId,
        transport: "core:C1/C2",
        mode: body.mode
      },
      state_changed_event: {
        type: "broadcast.state_changed",
        broadcast_id: broadcastId,
        status: nextStatus
      },
      created_at: startedAt
    });
  }),

  http.get(/\/api\/v1\/broadcasts\/([^/]+)\/stats$/, ({ request }) => {
    const broadcastId = getLastPathMatch(request.url, /\/broadcasts\/([^/]+)\/stats$/);
    const broadcast = currentBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return problem(404, "Not Found", "Broadcast not found.");
    }

    const stats = currentBroadcastStats[broadcastId] ?? {
      prepared: 0,
      sent: 0,
      delivered: 0,
      failed: 0,
      updated_at: broadcast.updated_at
    };

    return HttpResponse.json({
      contract: "C8.BroadcastStatsResponse",
      version: "1.0.0",
      request_id: "broadcast-stats-req",
      organization_id: broadcast.organization_id,
      broadcast_id: broadcastId,
      status: broadcast.status,
      stats: cloneBroadcastStats(stats)
    });
  }),

  http.get(`${API_PREFIX}/notifications/settings`, () => {
    return HttpResponse.json({
      contract: "C10.NotificationSettingsResponse",
      version: "1.0.0",
      request_id: "notification-settings-req",
      organization_id: currentOrganization.id,
      user_id: mockSession.user.id,
      settings: cloneNotificationSettings(currentNotificationSettings)
    });
  }),

  http.put(`${API_PREFIX}/notifications/settings`, async ({ request }) => {
    const body = (await request.json()) as Partial<UpdateNotificationSettingsRequest>;
    if (!Array.isArray(body.settings) || body.settings.length === 0) {
      return validationProblem(
        [{ field: "settings", message: "Нужно передать хотя бы одну настройку." }],
        "Request payload does not match C10.UpdateNotificationSettingsRequest DTO."
      );
    }

    const overrides = new Map(
      body.settings.map((setting) => [`${setting.category}:${setting.channel}`, setting.enabled])
    );
    currentNotificationSettings = currentNotificationSettings.map((setting) => {
      const key = `${setting.category}:${setting.channel}`;
      return overrides.has(key) ? { ...setting, enabled: Boolean(overrides.get(key)) } : setting;
    });

    return HttpResponse.json({
      contract: "C10.NotificationSettingsResponse",
      version: "1.0.0",
      request_id: "notification-settings-update-req",
      organization_id: currentOrganization.id,
      user_id: body.user_id ?? mockSession.user.id,
      settings: cloneNotificationSettings(currentNotificationSettings)
    });
  }),

  http.get(`${API_PREFIX}/notifications`, () => {
    return HttpResponse.json({
      contract: "C10.ListNotificationsResponse",
      version: "1.0.0",
      request_id: "notification-list-req",
      organization_id: currentOrganization.id,
      recipient_user_id: mockSession.user.id,
      items: currentNotifications.map(cloneNotification),
      page: {
        limit: 50,
        next_cursor: null
      }
    });
  }),

  http.post(/\/api\/v1\/notifications\/([^/]+):read$/, ({ request }) => {
    const notificationId = getLastPathMatch(request.url, /\/notifications\/([^/]+):read$/);
    let updated: Notification | null = null;
    currentNotifications = currentNotifications.map((notification) => {
      if (notification.id !== notificationId) {
        return notification;
      }

      updated = {
        ...cloneNotification(notification),
        status: "read",
        read_at: "2026-07-03T12:10:00.000Z"
      };
      return updated;
    });

    if (!updated) {
      return problem(404, "Not Found", "Notification not found.");
    }

    return HttpResponse.json({
      contract: "C10.MarkNotificationReadResponse",
      version: "1.0.0",
      request_id: "notification-read-req",
      organization_id: currentOrganization.id,
      notification: cloneNotification(updated)
    });
  })
];

export function resetMockBackendState() {
  currentSession = null;
  currentOrganization = { ...mockOrganization };
  currentConfiguration = { ...mockConfiguration };
  currentChannels = cloneChannels(mockChannels);
  currentDocuments = cloneDocuments(mockKnowledgeDocuments);
  currentWorkflows = mockWorkflows.map(cloneWorkflow);
  currentVersions = mockWorkflowVersions.map(cloneWorkflowVersion);
  currentSubschemas = mockWorkflowSubschemas.map(cloneWorkflowSubschema);
  currentInstances = mockWorkflowInstances.map(cloneWorkflowInstance);
  currentBroadcasts = mockBroadcasts.map(cloneBroadcast);
  currentBroadcastStats = cloneBroadcastStatsMap(mockBroadcastStats);
  currentNotifications = mockNotifications.map(cloneNotification);
  currentNotificationSettings = cloneNotificationSettings(mockNotificationSettings);
  nextChannelNumber = 1;
  nextDocumentNumber = 1;
  nextWorkflowVersionNumber = 1;
  nextOnboardingNumber = 1;
  nextConfigurationVersion = 2;
  nextBroadcastNumber = 1;
}

function createSessionForTelegramUsername(telegramUsername: string | undefined) {
  const normalized = telegramUsername?.replace(/^@/, "").toLowerCase();
  if (normalized === "operator_demo") {
    return createMockSession(["platform_operator"]);
  }

  return { ...mockSession };
}

function validateWorkflowVersionPayload(schema: WorkflowSchema | undefined) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!schema || typeof schema !== "object") {
    errors.push({ field: "schema", message: "Схема Workflow обязательна." });
    return errors;
  }

  const validation = validateWorkflowSchema(schema);
  for (const message of validation.errors) {
    errors.push({ field: "schema", message });
  }

  return errors;
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

  if (!input.channel_type || !CONNECTABLE_CHANNEL_TYPES.has(input.channel_type)) {
    errors.push({ field: "channel_type", message: "Поддержаны web_chat, telegram, max и email." });
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

function cloneBroadcastStatsMap(stats: Record<string, BroadcastStats>): Record<string, BroadcastStats> {
  return Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [key, cloneBroadcastStats(value)])
  );
}

function validateCreateBroadcast(input: Partial<CreateBroadcastRequest>) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (!input.organization_id) {
    errors.push({ field: "organization_id", message: "organization_id is required" });
  }

  if (!input.name || input.name.trim().length < 2) {
    errors.push({ field: "name", message: "Название кампании должно содержать минимум 2 символа." });
  }

  if (!input.template || typeof input.template.body !== "string" || input.template.body.trim().length === 0) {
    errors.push({ field: "template", message: "Текст сообщения обязателен." });
  }

  if (!input.rate_limit || !Number.isFinite(input.rate_limit.messages_per_minute) || Number(input.rate_limit.messages_per_minute) < 1) {
    errors.push({ field: "rate_limit", message: "Лимит сообщений в минуту должен быть положительным числом." });
  }

  return errors;
}

function validateStartBroadcast(input: Partial<StartBroadcastRequest>) {
  const errors: NonNullable<ProblemDetails["errors"]> = [];

  if (input.mode !== "immediate" && input.mode !== "scheduled") {
    errors.push({ field: "mode", message: "Режим запуска должен быть immediate или scheduled." });
  }

  if (input.mode === "scheduled" && !input.scheduled_for) {
    errors.push({ field: "scheduled_for", message: "Для запланированного запуска нужно указать дату и время." });
  }

  return errors;
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
