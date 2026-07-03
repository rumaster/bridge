export type ISODateTime = string;

export type AdminRole = "platform_operator" | "administrator" | "manager";

export interface AdminSession {
  authenticated: boolean;
  user: {
    id: string;
    organizationId: string;
    displayName: string;
    telegramUsername: string;
    status: "active" | "blocked";
  };
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  roles: AdminRole[];
  session: {
    id: string;
    mode: string;
    issuedAt: ISODateTime;
    expiresAt: ISODateTime | null;
  };
  implementationStage?: string;
}

export interface TelegramLoginStartRequest {
  telegramUsername: string;
}

export interface TelegramLoginStartResponse {
  status: string;
  deliveryChannel: "telegram";
  telegramUsername: string;
  expiresInSeconds: number;
  implementationStage?: string;
  note?: string;
}

export interface TelegramLoginVerifyRequest {
  telegramUsername: string;
  code: string;
}

export interface LogoutResponse {
  loggedOut: true;
  sessionMode: string;
  implementationStage?: string;
  note?: string;
}

export interface Organization {
  id: string;
  name: string;
  description: string;
  timezone: string;
  locale: string;
  status: "active" | "blocked";
  updatedAt: ISODateTime;
}

export interface UpdateOrganizationRequest {
  name: string;
  description: string;
  timezone: string;
  locale: string;
}

export interface OrganizationConfiguration {
  organizationId: string;
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
  updatedAt: ISODateTime;
}

export interface UpdateOrganizationConfigurationRequest {
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
}

export type ChannelStatus = "connected" | "error" | "disabled";
export type ChannelType = "web_chat" | "telegram" | "max" | "vk" | "whatsapp" | "email" | "sms";
export type ChannelCapabilityName =
  | "text"
  | "image"
  | "file"
  | "voice"
  | "video"
  | "buttons"
  | "reactions"
  | "typing_indicator"
  | "read_receipt"
  | "delete"
  | "edit";

export interface ChannelErrorLogItem {
  id: string;
  code: string;
  message: string;
  occurred_at: ISODateTime;
}

export interface Channel {
  id: string;
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  status: ChannelStatus;
  credentials_ref?: string;
  config: Record<string, unknown>;
  last_check_at?: ISODateTime;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  error_log?: ChannelErrorLogItem[];
}

export interface ConnectChannelRequest {
  organization_id: string;
  channel_type: "web_chat";
  name: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
}

export interface ConnectChannelResponse {
  channel: Channel;
}

export interface ChannelCapabilityDescriptor {
  contract: "C6.CapabilityDescriptor";
  version: string;
  channel_type: ChannelType;
  channel_id: string;
  adapter: {
    name: string;
    version: string;
  };
  capabilities: Record<ChannelCapabilityName, { supported: boolean; notes?: string }>;
  generated_at: ISODateTime;
}

export interface ChannelTestResult {
  accepted: true;
  channel_id: string;
  status: ChannelStatus;
  checked_at: ISODateTime;
  error?: ChannelErrorLogItem;
}

export type KnowledgeDocumentStatus = "indexing" | "indexed" | "failed";

export interface KnowledgeDocument {
  id: string;
  organization_id: string;
  title: string;
  source: string | null;
  status: KnowledgeDocumentStatus;
  indexed_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
  error_message?: string;
}

export interface CreateKnowledgeDocumentRequest {
  organization_id: string;
  title: string;
  source?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
}

export interface UpdateKnowledgeDocumentRequest {
  title: string;
  source?: string;
}

export interface ReindexKnowledgeDocumentResponse {
  accepted: true;
  document_id: string;
  status: "indexing";
  queued_at: ISODateTime;
}

export interface DeleteKnowledgeDocumentResponse {
  deleted: true;
  document_id: string;
}

// ── Workflow (C5, SVC-FBP) ────────────────────────────────────────────────
// UI-слой оперирует контрактом C5: список Workflow, неизменяемые версии схемы
// (ТЗ §13.10) и инстансы исполнения для истории/диагностики. Мутации данных в
// схеме допустимы только через узел вызова Backend API (ТЗ §13.5); UI лишь
// ограничивает палитру безопасным набором узлов (ТЗ §13.13) — авторитетную
// проверку выполняет Backend/FBP.
export type WorkflowStatus = "draft" | "active" | "archived";

export type WorkflowNodeType =
  | "backend_api_call"
  | "llm_call"
  | "kb_search"
  | "branch"
  | "transform"
  | "wait_event";

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, unknown>;
  position: WorkflowNodePosition;
}

export interface WorkflowConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowSchema {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

export interface Workflow {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  enabled: boolean;
  default_version_id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface WorkflowVersion {
  id: string;
  organization_id: string;
  workflow_id: string;
  version_no: number;
  schema: WorkflowSchema;
  created_by: string;
  created_at: ISODateTime;
}

export type WorkflowInstanceStatus =
  | "created"
  | "started"
  | "running"
  | "waiting"
  | "callback_recorded"
  | "completed"
  | "failed"
  | "cancelled"
  | "degraded";

export interface WorkflowInstanceLogEntry {
  id: string;
  node_id: string | null;
  node_type?: WorkflowNodeType;
  event: string;
  message: string;
  created_at: ISODateTime;
}

export interface WorkflowInstance {
  id: string;
  organization_id: string;
  workflow_id: string;
  workflow_version_id: string;
  version_no: number;
  status: WorkflowInstanceStatus;
  started_at: ISODateTime | null;
  finished_at: ISODateTime | null;
  created_at: ISODateTime;
}

export interface WorkflowInstanceDetail extends WorkflowInstance {
  logs: WorkflowInstanceLogEntry[];
}

export interface UpdateWorkflowRequest {
  enabled?: boolean;
  status?: WorkflowStatus;
  default_version_id?: string;
}

export interface CreateWorkflowVersionRequest {
  schema: WorkflowSchema;
  /** Сразу сделать новую версию активной (default). По умолчанию — нет: сохранение
   * версии не влияет на выполняющиеся инстансы (ТЗ §13.10). */
  activate?: boolean;
}

// ── AI Onboarding (C4, SVC-AI) ────────────────────────────────────────────
// Диалоговый помощник формирует структурированную команду (ТЗ §16.8). Команда —
// лишь описание намерения; Backend проверяет полномочия и схему (§12.6) и
// применяет изменения через единственный санкционированный путь (ТЗ §12.5).
export type OnboardingCommandAction =
  | "organization.update_profile"
  | "configuration.upsert"
  | "channel.connect"
  | "user.invite"
  | "noop";

export interface OnboardingCommand {
  contract: "C4.AiOnboardingCommand";
  version: string;
  command_id: string;
  organization_id: string;
  action: OnboardingCommandAction;
  params: Record<string, unknown>;
  safety: {
    apply_mode: "backend_validation_required";
    requires_confirmation: boolean;
    notes: string[];
  };
  source: {
    prompt: string;
    generated_by: "deterministic-mock-ai" | "fallback";
  };
  created_at: ISODateTime;
}

export interface OnboardingCommandRequest {
  prompt: string;
  request_id?: string;
}

export interface OnboardingCommandResponse {
  contract: "C4.OnboardingCommandResponse";
  version: string;
  request_id: string;
  organization_id: string;
  degraded: boolean;
  fallback_reason: "timeout" | "unavailable" | null;
  summary: string;
  assistant_message: string;
  command: OnboardingCommand;
}

export type OnboardingApplyStatus = "applied" | "noop" | "not_supported";

export interface OnboardingApplyResult {
  action: OnboardingCommandAction;
  applied: boolean;
  status: OnboardingApplyStatus;
  detail: Record<string, unknown>;
}

export interface OnboardingApplyRequest {
  command: OnboardingCommand;
}

export interface OnboardingApplyResponse {
  contract: "C4.OnboardingApplyResponse";
  version: string;
  request_id: string;
  organization_id: string;
  result: OnboardingApplyResult;
  configuration: OrganizationConfiguration;
  organization: Organization;
  applied_at: ISODateTime;
}

export type C7Event =
  | {
      type: "channel.status_changed";
      sequenceNumber: number;
      payload: {
        channelId: string;
        status: ChannelStatus;
        lastCheckAt?: ISODateTime;
        error?: ChannelErrorLogItem | null;
      };
    };

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: Array<{
    field: string;
    message: string;
  }>;
}

export interface SaasAdminApiClient {
  auth: {
    getSession: () => Promise<AdminSession>;
    startTelegramLogin: (request: TelegramLoginStartRequest) => Promise<TelegramLoginStartResponse>;
    verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => Promise<AdminSession>;
    logout: () => Promise<LogoutResponse>;
  };
  org: {
    getOrganization: (organizationId: string) => Promise<Organization>;
    updateOrganization: (
      organizationId: string,
      request: UpdateOrganizationRequest
    ) => Promise<Organization>;
    getConfiguration: (organizationId: string) => Promise<OrganizationConfiguration>;
    updateConfiguration: (
      organizationId: string,
      request: UpdateOrganizationConfigurationRequest
    ) => Promise<OrganizationConfiguration>;
  };
  channels: {
    listChannels: () => Promise<Channel[]>;
    createChannel: (request: ConnectChannelRequest) => Promise<ConnectChannelResponse>;
    getCapabilities: (channelId: string) => Promise<ChannelCapabilityDescriptor>;
    testChannel: (channelId: string) => Promise<ChannelTestResult>;
  };
  knowledge: {
    listDocuments: () => Promise<KnowledgeDocument[]>;
    createDocument: (request: CreateKnowledgeDocumentRequest) => Promise<KnowledgeDocument>;
    updateDocument: (
      documentId: string,
      request: UpdateKnowledgeDocumentRequest
    ) => Promise<KnowledgeDocument>;
    reindexDocument: (documentId: string) => Promise<ReindexKnowledgeDocumentResponse>;
    deleteDocument: (documentId: string) => Promise<DeleteKnowledgeDocumentResponse>;
  };
  workflows: {
    listWorkflows: () => Promise<Workflow[]>;
    listVersions: (workflowId: string) => Promise<WorkflowVersion[]>;
    createVersion: (
      workflowId: string,
      request: CreateWorkflowVersionRequest
    ) => Promise<WorkflowVersion>;
    updateWorkflow: (workflowId: string, request: UpdateWorkflowRequest) => Promise<Workflow>;
    listInstances: (workflowId: string) => Promise<WorkflowInstance[]>;
    getInstance: (workflowId: string, instanceId: string) => Promise<WorkflowInstanceDetail>;
  };
  onboarding: {
    createCommand: (request: OnboardingCommandRequest) => Promise<OnboardingCommandResponse>;
    applyCommand: (request: OnboardingApplyRequest) => Promise<OnboardingApplyResponse>;
  };
}
