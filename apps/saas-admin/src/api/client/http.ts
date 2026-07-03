import { createJsonApiClient } from "@bridge/api-client";
import type {
  AdminSession,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelTestResult,
  ConnectChannelRequest,
  ConnectChannelResponse,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowVersionRequest,
  DeleteKnowledgeDocumentResponse,
  KnowledgeDocument,
  LogoutResponse,
  OnboardingApplyRequest,
  OnboardingApplyResponse,
  OnboardingCommandRequest,
  OnboardingCommandResponse,
  Organization,
  OrganizationConfiguration,
  ReindexKnowledgeDocumentResponse,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest,
  UpdateKnowledgeDocumentRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowVersion
} from "./types";

export interface SaasAdminApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "/api/v1";

export function createSaasAdminApiClient(options: SaasAdminApiClientOptions = {}): SaasAdminApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
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
    }
  };
}
