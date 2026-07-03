import type {
  AdminSession,
  Channel,
  ChannelStatus,
  ConnectChannelRequest,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowVersionRequest,
  KnowledgeDocument,
  OnboardingApplyRequest,
  OnboardingCommandRequest,
  Organization,
  OrganizationConfiguration,
  SaasAdminApiClient,
  TelegramLoginStartRequest,
  TelegramLoginVerifyRequest,
  UpdateKnowledgeDocumentRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowInstance,
  WorkflowVersion
} from "../client/types";
import { createMockC7RealtimeClient } from "../client/realtime";
import type { C7RealtimeClient } from "../client/realtime";
import {
  applyOnboardingCommand,
  cloneWorkflow,
  cloneWorkflowInstance,
  cloneWorkflowInstanceDetail,
  cloneWorkflowSchema,
  cloneWorkflowVersion,
  createMockCapabilityDescriptor,
  deriveOnboardingCommand,
  mockC7Events,
  mockChannels,
  mockConfiguration,
  mockKnowledgeDocuments,
  mockOrganization,
  mockSession,
  mockWorkflowInstanceLogs,
  mockWorkflowInstances,
  mockWorkflowVersions,
  mockWorkflows
} from "./fixtures";

export interface CreateMockSaasAdminServicesOptions {
  authenticated?: boolean;
  realtime?: C7RealtimeClient;
  session?: AdminSession;
}

export function createMockSaasAdminApiClient(
  options: CreateMockSaasAdminServicesOptions = {}
): SaasAdminApiClient {
  const initialSession = options.session ?? mockSession;
  let currentSession: AdminSession | null = options.authenticated === false ? null : initialSession;
  let currentOrganization: Organization = cloneMockOrganization();
  let currentConfiguration: OrganizationConfiguration = cloneMockConfiguration();
  let currentChannels: Channel[] = cloneMockChannels();
  let currentDocuments: KnowledgeDocument[] = cloneMockKnowledgeDocuments();
  let currentWorkflows: Workflow[] = mockWorkflows.map(cloneWorkflow);
  let currentVersions: WorkflowVersion[] = mockWorkflowVersions.map(cloneWorkflowVersion);
  let currentInstances: WorkflowInstance[] = mockWorkflowInstances.map(cloneWorkflowInstance);
  let nextChannelNumber = 1;
  let nextDocumentNumber = 1;
  let nextVersionNumber = 1;
  let nextOnboardingNumber = 1;
  let nextConfigurationVersion = 2;

  return {
    auth: {
      async getSession() {
        if (!currentSession) {
          throw new Error("Session not found");
        }

        return currentSession;
      },
      async startTelegramLogin(request: TelegramLoginStartRequest) {
        if (!request.telegramUsername) {
          throw new Error("telegramUsername is required");
        }

        return {
          status: "mock_code_delivery_scheduled",
          deliveryChannel: "telegram",
          telegramUsername: request.telegramUsername.replace(/^@/, "").toLowerCase(),
          expiresInSeconds: 300,
          implementationStage: "M1"
        };
      },
      async verifyTelegramLogin(request: TelegramLoginVerifyRequest) {
        if (!request.telegramUsername || !request.code) {
          throw new Error("telegramUsername and code are required");
        }

        currentSession = initialSession;
        return initialSession;
      },
      async logout() {
        currentSession = null;
        return {
          loggedOut: true,
          sessionMode: "mock",
          implementationStage: "M1"
        };
      }
    },
    org: {
      async getOrganization(organizationId: string) {
        if (organizationId !== currentOrganization.id) {
          throw new Error("Organization not found");
        }

        return currentOrganization;
      },
      async updateOrganization(
        organizationId: string,
        request: UpdateOrganizationRequest
      ) {
        if (organizationId !== currentOrganization.id) {
          throw new Error("Organization not found");
        }

        currentOrganization = {
          ...currentOrganization,
          ...request,
          updatedAt: "2026-07-03T09:30:00.000Z"
        };

        return currentOrganization;
      },
      async getConfiguration(organizationId: string) {
        if (organizationId !== currentConfiguration.organizationId) {
          throw new Error("Organization configuration not found");
        }

        return currentConfiguration;
      },
      async updateConfiguration(
        organizationId: string,
        request: UpdateOrganizationConfigurationRequest
      ) {
        if (organizationId !== currentConfiguration.organizationId) {
          throw new Error("Organization configuration not found");
        }

        currentConfiguration = {
          ...currentConfiguration,
          ...request,
          updatedAt: "2026-07-03T09:31:00.000Z"
        };

        return currentConfiguration;
      }
    },
    channels: {
      async listChannels() {
        return currentChannels.map(cloneChannel);
      },
      async createChannel(request: ConnectChannelRequest) {
        if (!request.name.trim()) {
          throw new Error("Channel name is required");
        }

        const createdAt = "2026-07-03T10:20:00.000Z";
        const channel: Channel = {
          id: `channel-web-chat-created-${nextChannelNumber++}`,
          organization_id: request.organization_id,
          channel_type: request.channel_type,
          name: request.name.trim(),
          status: "connected",
          ...(request.credentials_ref?.trim()
            ? { credentials_ref: request.credentials_ref.trim() }
            : {}),
          config: request.config ?? {},
          last_check_at: createdAt,
          created_at: createdAt,
          updated_at: createdAt,
          error_log: []
        };

        currentChannels = [...currentChannels, channel];
        return {
          channel: cloneChannel(channel)
        };
      },
      async getCapabilities(channelId: string) {
        const channel = findChannel(currentChannels, channelId);
        return createMockCapabilityDescriptor(channel);
      },
      async testChannel(channelId: string) {
        const checkedAt = "2026-07-03T10:25:00.000Z";
        currentChannels = currentChannels.map((channel) =>
          channel.id === channelId
            ? {
                ...channel,
                status: "connected" as ChannelStatus,
                last_check_at: checkedAt,
                updated_at: checkedAt
              }
            : channel
        );

        return {
          accepted: true,
          channel_id: channelId,
          status: "connected",
          checked_at: checkedAt
        };
      }
    },
    knowledge: {
      async listDocuments() {
        return currentDocuments.map(cloneKnowledgeDocument);
      },
      async createDocument(request: CreateKnowledgeDocumentRequest) {
        if (!request.title.trim()) {
          throw new Error("Document title is required");
        }

        const createdAt = "2026-07-03T10:30:00.000Z";
        const document: KnowledgeDocument = {
          id: `kb-doc-created-${nextDocumentNumber++}`,
          organization_id: request.organization_id,
          title: request.title.trim(),
          source: request.source?.trim() || null,
          status: "indexing",
          indexed_at: null,
          created_at: createdAt,
          updated_at: createdAt,
          file_name: request.file_name,
          content_type: request.content_type,
          size_bytes: request.size_bytes
        };

        currentDocuments = [document, ...currentDocuments];
        return cloneKnowledgeDocument(document);
      },
      async updateDocument(documentId: string, request: UpdateKnowledgeDocumentRequest) {
        if (!request.title.trim()) {
          throw new Error("Document title is required");
        }

        let updated: KnowledgeDocument | null = null;
        currentDocuments = currentDocuments.map((document) => {
          if (document.id !== documentId) {
            return document;
          }

          updated = {
            ...document,
            title: request.title.trim(),
            source: request.source?.trim() || null,
            updated_at: "2026-07-03T10:32:00.000Z"
          };
          return updated;
        });

        if (!updated) {
          throw new Error("Knowledge document not found");
        }

        return cloneKnowledgeDocument(updated);
      },
      async reindexDocument(documentId: string) {
        const queuedAt = "2026-07-03T10:35:00.000Z";
        currentDocuments = currentDocuments.map((document) =>
          document.id === documentId
            ? {
                ...document,
                status: "indexing",
                indexed_at: null,
                updated_at: queuedAt,
                error_message: undefined
              }
            : document
        );

        return {
          accepted: true,
          document_id: documentId,
          status: "indexing",
          queued_at: queuedAt
        };
      },
      async deleteDocument(documentId: string) {
        currentDocuments = currentDocuments.filter((document) => document.id !== documentId);
        return {
          deleted: true,
          document_id: documentId
        };
      }
    },
    workflows: {
      async listWorkflows() {
        return currentWorkflows.map(cloneWorkflow);
      },
      async listVersions(workflowId: string) {
        requireWorkflow(currentWorkflows, workflowId);
        return currentVersions
          .filter((version) => version.workflow_id === workflowId)
          .map(cloneWorkflowVersion);
      },
      async createVersion(workflowId: string, request: CreateWorkflowVersionRequest) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        const versionNo =
          currentVersions
            .filter((version) => version.workflow_id === workflowId)
            .reduce((max, version) => Math.max(max, version.version_no), 0) + 1;
        const version: WorkflowVersion = {
          id: `wfv-created-${nextVersionNumber++}`,
          organization_id: workflow.organization_id,
          workflow_id: workflowId,
          version_no: versionNo,
          schema: cloneWorkflowSchema(request.schema),
          created_by: initialSession.user.displayName,
          created_at: "2026-07-03T11:15:00.000Z"
        };

        currentVersions = [...currentVersions, version];
        if (request.activate) {
          currentWorkflows = currentWorkflows.map((item) =>
            item.id === workflowId
              ? {
                  ...item,
                  status: "active",
                  default_version_id: version.id,
                  updated_at: "2026-07-03T11:15:00.000Z"
                }
              : item
          );
        }

        return cloneWorkflowVersion(version);
      },
      async updateWorkflow(workflowId: string, request: UpdateWorkflowRequest) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        if (
          request.default_version_id &&
          !currentVersions.some(
            (version) =>
              version.workflow_id === workflowId && version.id === request.default_version_id
          )
        ) {
          throw new Error("Workflow version not found");
        }

        const updated: Workflow = {
          ...workflow,
          enabled: request.enabled ?? workflow.enabled,
          status: request.status ?? workflow.status,
          default_version_id: request.default_version_id ?? workflow.default_version_id,
          updated_at: "2026-07-03T11:16:00.000Z"
        };
        currentWorkflows = currentWorkflows.map((item) =>
          item.id === workflowId ? updated : item
        );

        return cloneWorkflow(updated);
      },
      async listInstances(workflowId: string) {
        requireWorkflow(currentWorkflows, workflowId);
        return currentInstances
          .filter((instance) => instance.workflow_id === workflowId)
          .map(cloneWorkflowInstance);
      },
      async getInstance(workflowId: string, instanceId: string) {
        const instance = currentInstances.find(
          (item) => item.id === instanceId && item.workflow_id === workflowId
        );
        if (!instance) {
          throw new Error("Workflow instance not found");
        }

        return cloneWorkflowInstanceDetail({
          ...instance,
          logs: mockWorkflowInstanceLogs[instanceId] ?? []
        });
      }
    },
    onboarding: {
      async createCommand(request: OnboardingCommandRequest) {
        return deriveOnboardingCommand(
          request,
          {
            organizationId: currentOrganization.id,
            organization: currentOrganization,
            configuration: currentConfiguration
          },
          {
            requestId: request.request_id ?? `onboarding-req-${nextOnboardingNumber++}`,
            createdAt: "2026-07-03T11:00:00.000Z"
          }
        );
      },
      async applyCommand(request: OnboardingApplyRequest) {
        const { command } = request;
        if (command.organization_id !== currentOrganization.id) {
          throw new Error("Command organization mismatch");
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

        return {
          contract: "C4.OnboardingApplyResponse",
          version: "1.0.0",
          request_id: command.command_id,
          organization_id: currentOrganization.id,
          result,
          configuration: { ...configuration },
          organization: { ...organization },
          applied_at: "2026-07-03T11:00:05.000Z"
        };
      }
    }
  };
}

function requireWorkflow(workflows: Workflow[], workflowId: string): Workflow {
  const workflow = workflows.find((item) => item.id === workflowId);
  if (!workflow) {
    throw new Error("Workflow not found");
  }

  return workflow;
}

export function createMockSaasAdminServices(options: CreateMockSaasAdminServicesOptions = {}) {
  return {
    api: createMockSaasAdminApiClient(options),
    realtime: options.realtime ?? createMockC7RealtimeClient(mockC7Events)
  };
}

export function cloneMockOrganization(): Organization {
  return { ...mockOrganization };
}

export function cloneMockConfiguration(): OrganizationConfiguration {
  return { ...mockConfiguration };
}

export function cloneMockChannels(): Channel[] {
  return mockChannels.map(cloneChannel);
}

export function cloneMockKnowledgeDocuments(): KnowledgeDocument[] {
  return mockKnowledgeDocuments.map(cloneKnowledgeDocument);
}

function findChannel(channels: Channel[], channelId: string) {
  const channel = channels.find((item) => item.id === channelId);

  if (!channel) {
    throw new Error("Channel not found");
  }

  return channel;
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
