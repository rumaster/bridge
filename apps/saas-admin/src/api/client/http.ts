import { createJsonApiClient } from "@bridge/api-client";
import type {
  AdminSession,
  BroadcastStatsResponse,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelTestResult,
  ConnectChannelRequest,
  ConnectChannelResponse,
  CreateBroadcastRequest,
  CreateBroadcastResponse,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowVersionRequest,
  DeleteKnowledgeDocumentResponse,
  KnowledgeDocument,
  ListBroadcastsResponse,
  ListNotificationsResponse,
  LogoutResponse,
  MarkNotificationReadResponse,
  NotificationSettingsResponse,
  OnboardingApplyRequest,
  OnboardingApplyResponse,
  OnboardingCommandRequest,
  OnboardingCommandResponse,
  Organization,
  OrganizationConfiguration,
  ReindexKnowledgeDocumentResponse,
  SaasAdminApiClient,
  SaveWorkflowDraftRequest,
  StartBroadcastRequest,
  StartBroadcastResponse,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest,
  UpdateKnowledgeDocumentRequest,
  UpdateNotificationSettingsRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowDraft,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowVersion
} from "./types";

export interface SaasAdminApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "/api/v1";
const SAAS_ADMIN_SESSION_STORAGE_KEY = "bridge.saas-admin.session";
const TENANT_HEADER = "x-organization-id";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSaasAdminApiClient(options: SaasAdminApiClientOptions = {}): SaasAdminApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    defaultHeaders: readTenantHeaders,
    fetcher: options.fetcher
  });

  return {
    auth: {
      getSession: () => requestJson<AdminSession>("/auth/session"),
      startTelegramLogin: (request: TelegramLoginStartRequest) =>
        requestJson<TelegramLoginStartResponse>("/auth/login/telegram/start", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      verifyTelegramLogin: (request: TelegramLoginVerifyRequest) =>
        requestJson<AdminSession>("/auth/login/telegram/verify", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      logout: () =>
        requestJson<LogoutResponse>("/auth/logout", {
          method: "POST"
        })
    },
    org: {
      getOrganization: (organizationId: string) =>
        requestJson<Organization>(`/organizations/${organizationId}`),
      updateOrganization: (organizationId: string, request: UpdateOrganizationRequest) =>
        requestJson<Organization>(`/organizations/${organizationId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      getConfiguration: (organizationId: string) =>
        requestJson<OrganizationConfiguration>(`/organizations/${organizationId}/configuration`),
      updateConfiguration: (
        organizationId: string,
        request: UpdateOrganizationConfigurationRequest
      ) =>
        requestJson<OrganizationConfiguration>(`/organizations/${organizationId}/configuration`, {
          method: "PUT",
          body: JSON.stringify(request)
        })
    },
    channels: {
      listChannels: () => requestJson<Channel[]>("/channels"),
      createChannel: (request: ConnectChannelRequest) =>
        requestJson<ConnectChannelResponse>("/channels", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      getCapabilities: (channelId: string) =>
        requestJson<ChannelCapabilityDescriptor>(`/channels/${channelId}/capabilities`),
      testChannel: (channelId: string) =>
        requestJson<ChannelTestResult>(`/channels/${channelId}:test`, {
          method: "POST",
          body: JSON.stringify({})
        })
    },
    knowledge: {
      listDocuments: () => requestJson<KnowledgeDocument[]>("/knowledge/documents"),
      createDocument: (request: CreateKnowledgeDocumentRequest) =>
        requestJson<KnowledgeDocument>("/knowledge/documents", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      updateDocument: (documentId: string, request: UpdateKnowledgeDocumentRequest) =>
        requestJson<KnowledgeDocument>(`/knowledge/documents/${documentId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      reindexDocument: (documentId: string) =>
        requestJson<ReindexKnowledgeDocumentResponse>(`/knowledge/documents/${documentId}:reindex`, {
          method: "POST",
          body: JSON.stringify({})
        }),
      deleteDocument: (documentId: string) =>
        requestJson<DeleteKnowledgeDocumentResponse>(`/knowledge/documents/${documentId}`, {
          method: "DELETE"
        })
    },
    workflows: {
      listWorkflows: () => requestJson<Workflow[]>("/workflows"),
      listVersions: (workflowId: string) =>
        requestJson<WorkflowVersion[]>(`/workflows/${workflowId}/versions`),
      getDraft: (workflowId: string) =>
        requestJson<WorkflowDraft>(`/workflows/${workflowId}/draft`),
      saveDraft: (workflowId: string, request: SaveWorkflowDraftRequest) =>
        requestJson<WorkflowDraft>(`/workflows/${workflowId}/draft`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      promoteDraft: (workflowId: string) =>
        requestJson<WorkflowVersion>(`/workflows/${workflowId}/draft:promote`, {
          method: "POST",
          body: JSON.stringify({})
        }),
      resetDraft: (workflowId: string) =>
        requestJson<WorkflowDraft>(`/workflows/${workflowId}/draft`, {
          method: "DELETE"
        }),
      createVersion: (workflowId: string, request: CreateWorkflowVersionRequest) =>
        requestJson<WorkflowVersion>(`/workflows/${workflowId}/versions`, {
          method: "POST",
          body: JSON.stringify(request)
        }),
      updateWorkflow: (workflowId: string, request: UpdateWorkflowRequest) =>
        requestJson<Workflow>(`/workflows/${workflowId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      listInstances: (workflowId: string) =>
        requestJson<WorkflowInstance[]>(`/workflows/${workflowId}/instances`),
      getInstance: (workflowId: string, instanceId: string) =>
        requestJson<WorkflowInstanceDetail>(`/workflows/${workflowId}/instances/${instanceId}`)
    },
    onboarding: {
      createCommand: (request: OnboardingCommandRequest) =>
        requestJson<OnboardingCommandResponse>("/ai/onboarding:command", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      applyCommand: (request: OnboardingApplyRequest) =>
        requestJson<OnboardingApplyResponse>("/ai/onboarding:apply", {
          method: "POST",
          body: JSON.stringify(request)
        })
    },
    broadcasts: {
      listBroadcasts: () => requestJson<ListBroadcastsResponse>("/broadcasts"),
      createBroadcast: (request: CreateBroadcastRequest) =>
        requestJson<CreateBroadcastResponse>("/broadcasts", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      startBroadcast: (broadcastId: string, request: StartBroadcastRequest) =>
        requestJson<StartBroadcastResponse>(`/broadcasts/${broadcastId}:start`, {
          method: "POST",
          body: JSON.stringify(request)
        }),
      getStats: (broadcastId: string) =>
        requestJson<BroadcastStatsResponse>(`/broadcasts/${broadcastId}/stats`)
    },
    notifications: {
      listNotifications: () => requestJson<ListNotificationsResponse>("/notifications"),
      markRead: (notificationId: string) =>
        requestJson<MarkNotificationReadResponse>(`/notifications/${notificationId}:read`, {
          method: "POST",
          body: JSON.stringify({})
        }),
      getSettings: () => requestJson<NotificationSettingsResponse>("/notifications/settings"),
      updateSettings: (request: UpdateNotificationSettingsRequest) =>
        requestJson<NotificationSettingsResponse>("/notifications/settings", {
          method: "PUT",
          body: JSON.stringify(request)
        })
    }
  };
}

function readTenantHeaders(): HeadersInit {
  const organizationId = readStoredOrganizationId();

  return organizationId ? { [TENANT_HEADER]: organizationId } : {};
}

function readStoredOrganizationId() {
  if (typeof window === "undefined") {
    return undefined;
  }

  const storedSession = window.localStorage.getItem(SAAS_ADMIN_SESSION_STORAGE_KEY);
  if (!storedSession) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storedSession) as Partial<AdminSession>;
    const organizationId = parsed.organization?.id ?? parsed.user?.organizationId;

    return organizationId && UUID_V4_PATTERN.test(organizationId) ? organizationId : undefined;
  } catch {
    return undefined;
  }
}
