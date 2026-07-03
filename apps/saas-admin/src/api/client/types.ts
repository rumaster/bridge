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
}
