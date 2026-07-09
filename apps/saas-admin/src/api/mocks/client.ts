import type {
  AdminSession,
  BroadcastCampaign,
  BroadcastStats,
  Channel,
  ChannelStatus,
  ConnectChannelRequest,
  CreateBroadcastRequest,
  CreateKnowledgeDocumentRequest,
  CreateWorkflowVersionRequest,
  ImportWorkflowRequest,
  KnowledgeDocument,
  Notification,
  NotificationSetting,
  OnboardingApplyRequest,
  OnboardingCommandRequest,
  Organization,
  OrganizationConfiguration,
  SaasAdminApiClient,
  SaveWorkflowDraftRequest,
  StartBroadcastRequest,
  TelegramLoginStartRequest,
  TelegramLoginVerifyRequest,
  UpdateKnowledgeDocumentRequest,
  UpdateNotificationSettingsRequest,
  UpdateOrganizationConfigurationRequest,
  UpdateOrganizationRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowDraft,
  WorkflowInstance,
  WorkflowSubschema,
  WorkflowVersion
} from "../client/types";
import { createMockC7RealtimeClient } from "../client/realtime";
import type { C7RealtimeClient } from "../client/realtime";
import { validateWorkflowSchema } from "../../shared/workflow";
import {
  applyOnboardingCommand,
  cloneBroadcast,
  cloneBroadcastFilter,
  cloneBroadcastStats,
  cloneBroadcastTemplate,
  cloneNotification,
  cloneNotificationSettings,
  cloneWorkflow,
  cloneWorkflowDraft,
  cloneWorkflowInstance,
  cloneWorkflowInstanceDetail,
  cloneWorkflowSchema,
  cloneWorkflowSubschema,
  cloneWorkflowVersion,
  createMockCapabilityDescriptor,
  deriveOnboardingCommand,
  mockBroadcasts,
  mockBroadcastStats,
  mockC7Events,
  mockChannels,
  mockConfiguration,
  mockKnowledgeDocuments,
  mockNotifications,
  mockNotificationSettings,
  mockOrganization,
  mockSession,
  mockWorkflowInstanceLogs,
  mockWorkflowInstances,
  mockWorkflowSubschemas,
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
  let currentSubschemas: WorkflowSubschema[] = mockWorkflowSubschemas.map(cloneWorkflowSubschema);
  let currentWorkflowDrafts: Record<string, WorkflowDraft> = {};
  let currentInstances: WorkflowInstance[] = mockWorkflowInstances.map(cloneWorkflowInstance);
  let currentBroadcasts: BroadcastCampaign[] = mockBroadcasts.map(cloneBroadcast);
  let currentBroadcastStats: Record<string, BroadcastStats> = cloneMockBroadcastStats();
  let currentNotifications: Notification[] = mockNotifications.map(cloneNotification);
  let currentNotificationSettings: NotificationSetting[] =
    cloneNotificationSettings(mockNotificationSettings);
  let nextChannelNumber = 1;
  let nextDocumentNumber = 1;
  let nextVersionNumber = 1;
  let nextOnboardingNumber = 1;
  let nextConfigurationVersion = 2;
  let nextBroadcastNumber = 1;

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
          id: `channel-${request.channel_type.replace("_", "-")}-created-${nextChannelNumber++}`,
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
      async listSubschemas() {
        return currentSubschemas.map(cloneWorkflowSubschema);
      },
      async getDraft(workflowId: string) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        return cloneWorkflowDraft(
          currentWorkflowDrafts[workflowId] ?? emptyWorkflowDraft(workflow)
        );
      },
      async saveDraft(workflowId: string, request: SaveWorkflowDraftRequest) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        validateWorkflowDraftRequest(request);

        const draft: WorkflowDraft = {
          organization_id: workflow.organization_id,
          workflow_id: workflow.id,
          has_draft: true,
          schema: cloneWorkflowSchema(request.schema),
          draft_updated_at: "2026-07-03T11:14:00.000Z"
        };
        currentWorkflowDrafts = {
          ...currentWorkflowDrafts,
          [workflowId]: draft
        };

        return cloneWorkflowDraft(draft);
      },
      async promoteDraft(workflowId: string) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        const draft = currentWorkflowDrafts[workflowId];
        if (!draft?.schema) {
          throw new Error("Workflow draft not found");
        }

        const versionNo =
          currentVersions
            .filter((version) => version.workflow_id === workflowId)
            .reduce((max, version) => Math.max(max, version.version_no), 0) + 1;
        const version: WorkflowVersion = {
          id: `wfv-created-${nextVersionNumber++}`,
          organization_id: workflow.organization_id,
          workflow_id: workflowId,
          version_no: versionNo,
          schema: cloneWorkflowSchema(draft.schema),
          created_by: initialSession.user.displayName,
          created_at: "2026-07-03T11:15:00.000Z"
        };

        currentVersions = [...currentVersions, version];
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
        delete currentWorkflowDrafts[workflowId];

        return cloneWorkflowVersion(version);
      },
      async resetDraft(workflowId: string) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        delete currentWorkflowDrafts[workflowId];
        return cloneWorkflowDraft(emptyWorkflowDraft(workflow));
      },
      async exportWorkflow(workflowId: string) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        const version = currentVersions.find(
          (item) => item.workflow_id === workflowId && item.id === workflow.default_version_id
        );
        if (!version) {
          throw new Error("Workflow default version not found");
        }

        return {
          contract: "C5.WorkflowSchemaExport" as const,
          version: "1.0.0",
          exported_at: "2026-07-03T11:17:00.000Z",
          workflow: {
            id: workflow.id,
            name: workflow.name,
            version_id: version.id,
            version_no: version.version_no
          },
          schema: cloneWorkflowSchema(version.schema)
        };
      },
      async importWorkflow(workflowId: string, request: ImportWorkflowRequest) {
        const workflow = requireWorkflow(currentWorkflows, workflowId);
        if (request.contract !== "C5.WorkflowSchemaExport" || request.version !== "1.0.0") {
          throw new Error("Workflow import JSON is invalid");
        }
        validateWorkflowDraftRequest({ schema: request.schema });

        if (request.target === "version") {
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

          return { target: "version" as const, version: cloneWorkflowVersion(version) };
        }

        const draft: WorkflowDraft = {
          organization_id: workflow.organization_id,
          workflow_id: workflow.id,
          has_draft: true,
          schema: cloneWorkflowSchema(request.schema),
          draft_updated_at: "2026-07-03T11:14:00.000Z"
        };
        currentWorkflowDrafts = {
          ...currentWorkflowDrafts,
          [workflowId]: draft
        };

        return { draft: cloneWorkflowDraft(draft), target: "draft" as const };
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
    },
    broadcasts: {
      async listBroadcasts() {
        return {
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
        };
      },
      async createBroadcast(request: CreateBroadcastRequest) {
        if (!request.name.trim()) {
          throw new Error("Broadcast name is required");
        }
        if (!request.template.body.trim()) {
          throw new Error("Broadcast template body is required");
        }
        if (request.rate_limit.messages_per_minute < 1) {
          throw new Error("Broadcast rate limit must be at least 1 message per minute");
        }

        const createdAt = "2026-07-03T12:00:00.000Z";
        const broadcast: BroadcastCampaign = {
          id: `broadcast-created-${nextBroadcastNumber++}`,
          organization_id: request.organization_id,
          name: request.name.trim(),
          status: "draft",
          template: cloneBroadcastTemplate(request.template),
          filter: cloneBroadcastFilter(request.filter),
          schedule: { ...request.schedule },
          rate_limit: { ...request.rate_limit },
          created_by: request.created_by,
          created_at: createdAt,
          updated_at: createdAt
        };

        currentBroadcasts = [broadcast, ...currentBroadcasts];
        currentBroadcastStats = {
          ...currentBroadcastStats,
          [broadcast.id]: {
            prepared: 0,
            sent: 0,
            delivered: 0,
            failed: 0,
            updated_at: createdAt
          }
        };

        return {
          contract: "C8.CreateBroadcastResponse",
          version: "1.0.0",
          request_id: "broadcast-create-req",
          organization_id: broadcast.organization_id,
          broadcast: cloneBroadcast(broadcast)
        };
      },
      async startBroadcast(broadcastId: string, request: StartBroadcastRequest) {
        const existing = currentBroadcasts.find((item) => item.id === broadcastId);
        if (!existing) {
          throw new Error("Broadcast not found");
        }
        if (request.mode === "scheduled" && !request.scheduled_for) {
          throw new Error("scheduled_for is required for scheduled broadcasts");
        }

        const startedAt = "2026-07-03T12:05:00.000Z";
        const nextStatus = request.mode === "scheduled" ? "scheduled" : "running";
        const updated: BroadcastCampaign = {
          ...cloneBroadcast(existing),
          status: nextStatus,
          schedule: {
            ...existing.schedule,
            mode: request.mode,
            ...(request.scheduled_for ? { scheduled_for: request.scheduled_for } : {})
          },
          updated_at: startedAt
        };
        currentBroadcasts = currentBroadcasts.map((item) =>
          item.id === broadcastId ? updated : item
        );

        return {
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
            mode: request.mode
          },
          state_changed_event: {
            type: "broadcast.state_changed",
            broadcast_id: broadcastId,
            status: nextStatus
          },
          created_at: startedAt
        };
      },
      async getStats(broadcastId: string) {
        const broadcast = currentBroadcasts.find((item) => item.id === broadcastId);
        if (!broadcast) {
          throw new Error("Broadcast not found");
        }

        const stats = currentBroadcastStats[broadcastId] ?? {
          prepared: 0,
          sent: 0,
          delivered: 0,
          failed: 0,
          updated_at: broadcast.updated_at
        };

        return {
          contract: "C8.BroadcastStatsResponse",
          version: "1.0.0",
          request_id: "broadcast-stats-req",
          organization_id: broadcast.organization_id,
          broadcast_id: broadcastId,
          status: broadcast.status,
          stats: cloneBroadcastStats(stats)
        };
      }
    },
    notifications: {
      async listNotifications() {
        return {
          contract: "C10.ListNotificationsResponse",
          version: "1.0.0",
          request_id: "notification-list-req",
          organization_id: currentOrganization.id,
          recipient_user_id: initialSession.user.id,
          items: currentNotifications.map(cloneNotification),
          page: {
            limit: 50,
            next_cursor: null
          }
        };
      },
      async markRead(notificationId: string) {
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
          throw new Error("Notification not found");
        }

        return {
          contract: "C10.MarkNotificationReadResponse",
          version: "1.0.0",
          request_id: "notification-read-req",
          organization_id: currentOrganization.id,
          notification: cloneNotification(updated)
        };
      },
      async getSettings() {
        return {
          contract: "C10.NotificationSettingsResponse",
          version: "1.0.0",
          request_id: "notification-settings-req",
          organization_id: currentOrganization.id,
          user_id: initialSession.user.id,
          settings: cloneNotificationSettings(currentNotificationSettings)
        };
      },
      async updateSettings(request: UpdateNotificationSettingsRequest) {
        if (request.settings.length === 0) {
          throw new Error("At least one notification setting is required");
        }

        const overrides = new Map(
          request.settings.map((setting) => [`${setting.category}:${setting.channel}`, setting.enabled])
        );
        currentNotificationSettings = currentNotificationSettings.map((setting) => {
          const key = `${setting.category}:${setting.channel}`;
          return overrides.has(key) ? { ...setting, enabled: overrides.get(key)! } : setting;
        });

        return {
          contract: "C10.NotificationSettingsResponse",
          version: "1.0.0",
          request_id: "notification-settings-update-req",
          organization_id: currentOrganization.id,
          user_id: request.user_id,
          settings: cloneNotificationSettings(currentNotificationSettings)
        };
      }
    }
  };
}

function cloneMockBroadcastStats(): Record<string, BroadcastStats> {
  return Object.fromEntries(
    Object.entries(mockBroadcastStats).map(([id, stats]) => [id, cloneBroadcastStats(stats)])
  );
}

function requireWorkflow(workflows: Workflow[], workflowId: string): Workflow {
  const workflow = workflows.find((item) => item.id === workflowId);
  if (!workflow) {
    throw new Error("Workflow not found");
  }

  return workflow;
}

function emptyWorkflowDraft(workflow: Workflow): WorkflowDraft {
  return {
    organization_id: workflow.organization_id,
    workflow_id: workflow.id,
    has_draft: false,
    schema: null,
    draft_updated_at: null
  };
}

function validateWorkflowDraftRequest(request: SaveWorkflowDraftRequest): void {
  const validation = validateWorkflowSchema(request.schema);
  if (!validation.valid) {
    throw new Error("Workflow draft schema is invalid");
  }
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
