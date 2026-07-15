import { createJsonApiClient } from "@bridge/api-client";
import type {
  AdminSession,
  BroadcastStatsResponse,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelTestResult,
  ConnectChannelRequest,
  ConnectChannelResponse,
  UpdateChannelRequest,
  DeleteChannelResponse,
  OrderMailboxRequest,
  OrderMailboxResponse,
  CreateBroadcastRequest,
  CreateBroadcastResponse,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowSubschemaRequest,
  CreateWorkflowVersionRequest,
  ImportWorkflowRequest,
  ImportWorkflowResponse,
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
  OrganizationUser,
  RegistrationStartRequest,
  RegistrationStartResponse,
  RegistrationStatusResponse,
  RegistrationVerifyRequest,
  CreateUserRequest,
  PatchUserRequest,
  UserListResponse,
  RevokeUserSessionsResponse,
  Invitation,
  CreateInvitationRequest,
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
  UpdateWorkflowSubschemaRequest,
  Workflow,
  WorkflowDraft,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowSchemaExport,
  WorkflowSubschema,
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
      startRegistration: (request: RegistrationStartRequest) =>
        requestJson<RegistrationStartResponse>("/auth/register/start", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      getRegistrationStatus: (requestId: string) =>
        requestJson<RegistrationStatusResponse>(
          `/auth/register/status/${encodeURIComponent(requestId)}`
        ),
      verifyRegistration: (request: RegistrationVerifyRequest) =>
        requestJson<AdminSession>("/auth/register/verify", {
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
    users: {
      listUsers: (organizationId: string) =>
        requestJson<UserListResponse>(`/organizations/${organizationId}/users`).then(
          (response) => response.items
        ),
      createUser: (organizationId: string, request: CreateUserRequest) =>
        requestJson<OrganizationUser>(`/organizations/${organizationId}/users`, {
          method: "POST",
          body: JSON.stringify(request)
        }),
      patchUser: (userId: string, request: PatchUserRequest) =>
        requestJson<OrganizationUser>(`/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
      revokeSessions: (userId: string) =>
        requestJson<RevokeUserSessionsResponse>(`/users/${userId}/sessions:revoke`, {
          method: "POST",
          body: JSON.stringify({})
        }),
      createInvitation: (request: CreateInvitationRequest) =>
        requestJson<Invitation>("/invitations", {
          method: "POST",
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
      updateChannel: (channelId: string, request: UpdateChannelRequest) =>
        requestJson<ConnectChannelResponse>(`/channels/${channelId}`, {
          method: "PUT",
          body: JSON.stringify(request)
        }),
      deleteChannel: (channelId: string) =>
        requestJson<DeleteChannelResponse>(`/channels/${channelId}`, {
          method: "DELETE"
        }),
      getCapabilities: (channelId: string) =>
        requestJson<ChannelCapabilityDescriptor>(`/channels/${channelId}/capabilities`),
      testChannel: (channelId: string) =>
        requestJson<ChannelTestResult>(`/channels/${channelId}:test`, {
          method: "POST",
          body: JSON.stringify({})
        }),
      orderMailbox: (request: OrderMailboxRequest) =>
        requestJson<OrderMailboxResponse>("/mail/mailboxes", {
          method: "POST",
          body: JSON.stringify(request)
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
      deleteDocument: (documentId: string) =>
        requestJson<DeleteKnowledgeDocumentResponse>(`/knowledge/documents/${documentId}`, {
          method: "DELETE"
        })
    },
    workflows: {
      listWorkflows: () => requestJson<Workflow[]>("/workflows"),
      listVersions: (workflowId: string) =>
        requestJson<WorkflowVersion[]>(`/workflows/${workflowId}/versions`),
      listSubschemas: () => requestJson<WorkflowSubschema[]>("/workflow-subschemas"),
      createSubschema: (request: CreateWorkflowSubschemaRequest) =>
        requestJson<WorkflowSubschema>("/workflow-subschemas", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      updateSubschema: (subschemaId: string, request: UpdateWorkflowSubschemaRequest) =>
        requestJson<WorkflowSubschema>(`/workflow-subschemas/${subschemaId}`, {
          method: "PATCH",
          body: JSON.stringify(request)
        }),
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
      exportWorkflow: (workflowId: string) =>
        requestJson<WorkflowSchemaExport>(`/workflows/${workflowId}/export`),
      importWorkflow: (workflowId: string, request: ImportWorkflowRequest) =>
        requestJson<ImportWorkflowResponse>(`/workflows/${workflowId}/import`, {
          method: "POST",
          body: JSON.stringify(request)
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
