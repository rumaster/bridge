import type { FbpNodeType } from "@bridge/contracts/c5-workflow";

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
  key?: string;
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
  version?: number;
  updatedBy?: string | null;
  updatedAt: ISODateTime | null;
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
export type ConnectableChannelType = Extract<ChannelType, "web_chat" | "telegram" | "max" | "email">;
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

/** Креды одного почтового сервера (IMAP приём либо SMTP отправка), Этап E1. */
export interface EmailEndpointCredentials {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

/** Структурные креды email-канала (IMAP + SMTP + отправитель), Этап E1. */
export interface EmailChannelCredentials {
  imap: EmailEndpointCredentials;
  smtp: EmailEndpointCredentials;
  from_email: string;
  from_name?: string;
}

export interface ConnectChannelRequest {
  organization_id: string;
  channel_type: ConnectableChannelType;
  name: string;
  credentials_ref?: string;
  /** Plaintext-секрет канала (например токен Telegram-бота). Шифруется на бэкенде, не возвращается. */
  credentials?: string;
  /** Структурные креды email-канала (IMAP + SMTP). Только для channel_type=email; шифруются на бэкенде. */
  email_credentials?: EmailChannelCredentials;
  config?: Record<string, unknown>;
}

export interface ConnectChannelResponse {
  channel: Channel;
}

/**
 * Обновление канала (PUT /channels/:id). Все поля опциональны — шлём только
 * изменяемые. Секрет (`credentials`/`email_credentials`) перешифровывается на
 * бэкенде и не возвращается. organization_id берётся из заголовка, в тело не идёт.
 */
export interface UpdateChannelRequest {
  name?: string;
  credentials?: string;
  email_credentials?: EmailChannelCredentials;
  config?: Record<string, unknown>;
}

export interface DeleteChannelResponse {
  deleted: true;
  channel_id: string;
}

export interface OrderMailboxRequest {
  local_part: string;
  name?: string;
}

export interface OrderMailboxResponse {
  address: string;
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

export type WorkflowNodeType = FbpNodeType;

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
  fromPort: string;
  to: string;
  toPort: string;
  label?: string;
}

export interface WorkflowSchema {
  schema_version?: string;
  entry?: string;
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

export interface WorkflowSubschema {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  schema: WorkflowSchema;
  status: "draft" | "active";
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface WorkflowDraft {
  organization_id: string;
  workflow_id: string;
  has_draft: boolean;
  schema: WorkflowSchema | null;
  draft_updated_at: ISODateTime | null;
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

export interface SaveWorkflowDraftRequest {
  schema: WorkflowSchema;
}

export type WorkflowImportTarget = "draft" | "version";

export interface WorkflowSchemaExportWorkflow {
  id: string;
  name: string;
  version_id: string;
  version_no: number;
}

export interface WorkflowSchemaExport {
  contract: "C5.WorkflowSchemaExport";
  version: string;
  exported_at: ISODateTime;
  workflow: WorkflowSchemaExportWorkflow;
  schema: WorkflowSchema;
}

export interface ImportWorkflowRequest extends WorkflowSchemaExport {
  target?: WorkflowImportTarget;
  activate?: boolean;
}

export interface ImportWorkflowResponse {
  target: WorkflowImportTarget;
  draft?: WorkflowDraft;
  version?: WorkflowVersion;
}

export interface CreateWorkflowSubschemaRequest {
  slug: string;
  name: string;
}

export interface UpdateWorkflowSubschemaRequest {
  schema: WorkflowSchema;
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
    generated_by: "generated" | "fallback";
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

// ── Broadcast (C8, SVC-BCAST) ─────────────────────────────────────────────
// UI-слой управляет массовыми коммуникациями через фасад C8 (CP-6): черновик
// кампании, запуск и статистика. UI НЕ реализует логику доставки — материализация
// получателей, планирование и рассылка остаются за SVC-BCAST/ядром (ТЗ §21.5),
// а фасад лишь принимает описание кампании и возвращает C8 ответы.
export type BroadcastStatus = "draft" | "scheduled" | "running" | "done" | "failed";

export interface BroadcastTemplate {
  type: "text";
  body: string;
  locale?: string;
  variables?: string[];
}

export type BroadcastFilterMode = "all" | "tags" | "segment" | "custom";

export interface BroadcastFilter {
  mode: BroadcastFilterMode;
  channels?: string[];
  tags?: string[];
  segment_ids?: string[];
  criteria?: Record<string, unknown>;
}

export type BroadcastScheduleMode = "manual" | "immediate" | "scheduled" | "event" | "workflow";

export interface BroadcastSchedule {
  mode: BroadcastScheduleMode;
  scheduled_for?: ISODateTime;
  timezone?: string;
  trigger?: string;
}

export type BroadcastRateLimitStrategy = "fixed" | "channel_capability";

export interface BroadcastRateLimit {
  messages_per_minute: number;
  burst?: number;
  strategy?: BroadcastRateLimitStrategy;
}

export interface BroadcastCampaign {
  id: string;
  organization_id: string;
  name: string;
  status: BroadcastStatus;
  template: BroadcastTemplate;
  filter: BroadcastFilter;
  schedule: BroadcastSchedule;
  rate_limit: BroadcastRateLimit;
  created_by: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface BroadcastStats {
  prepared: number;
  sent: number;
  delivered: number;
  failed: number;
  updated_at: ISODateTime;
}

// organization_id берётся сервером из заголовка x-organization-id, created_by — из
// сессии; в теле запроса они запрещены (NestJS forbidNonWhitelisted → VALIDATION_FAILED).
export interface CreateBroadcastRequest {
  name: string;
  template: BroadcastTemplate;
  filter: BroadcastFilter;
  schedule: BroadcastSchedule;
  rate_limit: BroadcastRateLimit;
}

export interface ListBroadcastsResponse {
  contract: "C8.ListBroadcastsResponse";
  version: string;
  request_id?: string;
  organization_id: string;
  items: BroadcastCampaign[];
  page: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface CreateBroadcastResponse {
  contract: "C8.CreateBroadcastResponse";
  version: string;
  request_id: string;
  organization_id: string;
  broadcast: BroadcastCampaign;
}

export type BroadcastStartMode = "immediate" | "scheduled";

// organization_id — из заголовка, started_by — из сессии; в теле запрещены.
export interface StartBroadcastRequest {
  mode: BroadcastStartMode;
  scheduled_for?: ISODateTime;
  idempotency_key?: string;
}

export interface StartBroadcastResponse {
  contract: "C8.StartBroadcastResponse";
  version: string;
  request_id: string;
  organization_id: string;
  broadcast: BroadcastCampaign;
  degraded: boolean;
  fallback_reason: "timeout" | "unavailable" | null;
  core_delivery_draft: Record<string, unknown>;
  state_changed_event: Record<string, unknown>;
  created_at: ISODateTime;
}

export interface BroadcastStatsResponse {
  contract: "C8.BroadcastStatsResponse";
  version: string;
  request_id: string;
  organization_id: string;
  broadcast_id: string;
  status: BroadcastStatus;
  stats: BroadcastStats;
}

// ── Notification (C10, SVC-NOTIF) ─────────────────────────────────────────
// UI отображает ленту уведомлений текущего пользователя, отмечает «прочитано» и
// управляет настройками категорий/каналов доставки (CP-8, ТЗ §15.4). Генерация и
// доставка уведомлений — вне UI (ТЗ §21.5); UI лишь вызывает фасад C10.
export type NotificationCategory = "info" | "warning" | "error" | "critical" | "admin";
export type NotificationChannel = "web" | "telegram" | "email" | "push";
export type NotificationStatus = "new" | "read";

export interface Notification {
  contract: "C10.Notification";
  version: string;
  id: string;
  organization_id: string;
  recipient_user_id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  channels: NotificationChannel[];
  created_at: ISODateTime;
  read_at: ISODateTime | null;
  dedupe_key?: string;
}

export interface NotificationSetting {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface ListNotificationsResponse {
  contract: "C10.ListNotificationsResponse";
  version: string;
  request_id: string;
  organization_id: string;
  recipient_user_id: string;
  items: Notification[];
  page: {
    limit: number;
    next_cursor: string | null;
  };
}

export interface MarkNotificationReadResponse {
  contract: "C10.MarkNotificationReadResponse";
  version: string;
  request_id: string;
  organization_id: string;
  notification: Notification;
}

// organization_id — из заголовка, user_id — из сессии; в теле запрещены.
export interface UpdateNotificationSettingsRequest {
  settings: NotificationSetting[];
}

export interface NotificationSettingsResponse {
  contract: "C10.NotificationSettingsResponse";
  version: string;
  request_id: string;
  organization_id: string;
  user_id: string;
  settings: NotificationSetting[];
}

export type C7Event =
  | {
      type: "channel.status_changed";
      eventId?: string;
      sequenceNumber: number;
      payload: {
        channelId: string;
        status: ChannelStatus;
        lastCheckAt?: ISODateTime;
        error?: ChannelErrorLogItem | null;
      };
    }
  | {
      type: "broadcast.state_changed";
      eventId?: string;
      sequenceNumber: number;
      payload: {
        broadcastId: string;
        status: BroadcastStatus;
        stats?: BroadcastStats;
      };
    }
  | {
      type: "notification.created";
      eventId?: string;
      sequenceNumber: number;
      payload: {
        notification: Notification;
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

// ── Пользователи / менеджеры организации (C3 users, SVC-API) ──────────────
// Администратор организации управляет менеджерами: список, создание, изменение
// (роли/статус/контакты), блокировка (status=blocked → бэкенд гасит сессии),
// приглашения. organizationId в теле patch/revoke не нужен — берётся из заголовка.

export type OrganizationUserStatus = "active" | "blocked";

export interface OrganizationUser {
  id: string;
  organizationId: string;
  displayName: string;
  email: string | null;
  telegramUsername: string | null;
  telegramId: string | null;
  status: OrganizationUserStatus;
  roleCodes: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateUserRequest {
  displayName: string;
  email?: string;
  telegramUsername?: string;
  telegramId?: string;
  status?: OrganizationUserStatus;
  roleCodes?: string[];
}

export interface PatchUserRequest {
  displayName?: string;
  email?: string | null;
  telegramUsername?: string | null;
  telegramId?: string | null;
  status?: OrganizationUserStatus;
  roleCodes?: string[];
}

export interface UserListResponse {
  items: OrganizationUser[];
}

export interface RevokeUserSessionsResponse {
  userId: string;
  organizationId: string;
  revokedCount: number;
}

export interface Invitation {
  id: string;
  organizationId: string;
  contactType: "email" | "telegram";
  contactValue: string;
  roleCode: string;
  expiresAt: ISODateTime;
  acceptedAt: ISODateTime | null;
  createdBy: string | null;
  createdAt: ISODateTime;
  /** Сырой токен приглашения — показывается админу для передачи менеджеру
   * (автодоставка письма/сообщения пока не подключена). */
  token: string;
}

export interface CreateInvitationRequest {
  organizationId: string;
  contactType: "email" | "telegram";
  contactValue: string;
  roleCode?: "administrator" | "manager";
  displayName?: string;
  expiresInSeconds?: number;
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
    updateChannel: (
      channelId: string,
      request: UpdateChannelRequest
    ) => Promise<ConnectChannelResponse>;
    deleteChannel: (channelId: string) => Promise<DeleteChannelResponse>;
    getCapabilities: (channelId: string) => Promise<ChannelCapabilityDescriptor>;
    testChannel: (channelId: string) => Promise<ChannelTestResult>;
    orderMailbox: (request: OrderMailboxRequest) => Promise<OrderMailboxResponse>;
  };
  users: {
    listUsers: (organizationId: string) => Promise<OrganizationUser[]>;
    createUser: (organizationId: string, request: CreateUserRequest) => Promise<OrganizationUser>;
    patchUser: (userId: string, request: PatchUserRequest) => Promise<OrganizationUser>;
    revokeSessions: (userId: string) => Promise<RevokeUserSessionsResponse>;
    createInvitation: (request: CreateInvitationRequest) => Promise<Invitation>;
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
    listSubschemas: () => Promise<WorkflowSubschema[]>;
    createSubschema: (request: CreateWorkflowSubschemaRequest) => Promise<WorkflowSubschema>;
    updateSubschema: (
      subschemaId: string,
      request: UpdateWorkflowSubschemaRequest
    ) => Promise<WorkflowSubschema>;
    getDraft: (workflowId: string) => Promise<WorkflowDraft>;
    saveDraft: (
      workflowId: string,
      request: SaveWorkflowDraftRequest
    ) => Promise<WorkflowDraft>;
    promoteDraft: (workflowId: string) => Promise<WorkflowVersion>;
    resetDraft: (workflowId: string) => Promise<WorkflowDraft>;
    exportWorkflow: (workflowId: string) => Promise<WorkflowSchemaExport>;
    importWorkflow: (
      workflowId: string,
      request: ImportWorkflowRequest
    ) => Promise<ImportWorkflowResponse>;
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
  broadcasts: {
    listBroadcasts: () => Promise<ListBroadcastsResponse>;
    createBroadcast: (request: CreateBroadcastRequest) => Promise<CreateBroadcastResponse>;
    startBroadcast: (
      broadcastId: string,
      request: StartBroadcastRequest
    ) => Promise<StartBroadcastResponse>;
    getStats: (broadcastId: string) => Promise<BroadcastStatsResponse>;
  };
  notifications: {
    listNotifications: () => Promise<ListNotificationsResponse>;
    markRead: (notificationId: string) => Promise<MarkNotificationReadResponse>;
    getSettings: () => Promise<NotificationSettingsResponse>;
    updateSettings: (
      request: UpdateNotificationSettingsRequest
    ) => Promise<NotificationSettingsResponse>;
  };
}
