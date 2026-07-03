export type ISODateTime = string;

export interface ManagerSession {
  token: string;
  user: {
    id: string;
    displayName: string;
    role: "manager";
    telegramUsername: string;
  };
  organization: {
    id: string;
    name: string;
  };
  expiresAt: ISODateTime;
}

export interface TelegramLoginStartRequest {
  telegramUsername: string;
}

export interface TelegramLoginStartResponse {
  requestId: string;
  delivery: "telegram";
  expiresAt: ISODateTime;
}

export interface TelegramLoginVerifyRequest {
  requestId: string;
  code: string;
}

export type ConversationStatus = "open" | "pending" | "closed";
export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "received" | "routed" | "sent" | "delivered" | "failed";
export type MessageSenderType = "client" | "manager" | "system";
export type Channel = "web_chat" | "telegram";
export type ClientPresenceStatus = "online" | "offline";

export interface Conversation {
  id: string;
  clientId: string;
  status: ConversationStatus;
  channel: Channel;
  lastMessageAt: ISODateTime;
  lastMessagePreview: string;
  unreadCount: number;
}

export interface Message {
  id: string;
  conversationId: string;
  channel: Channel;
  direction: MessageDirection;
  senderType: MessageSenderType;
  content: string;
  status: MessageStatus;
  createdAt: ISODateTime;
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface SendMessageRequest {
  conversationId: string;
  content: string;
  idempotencyKey: string;
}

export interface CommunicationEndpoint {
  id: string;
  channel: Channel;
  externalId: string;
  displayName: string;
}

export interface ClientProfile {
  id: string;
  displayName: string;
  status?: ClientPresenceStatus;
  tags: string[];
  notes: string[];
  endpoints: CommunicationEndpoint[];
}

export type NotificationCategory = "info" | "warning" | "error" | "critical" | "admin";
export type NotificationStatus = "new" | "read";

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  status: NotificationStatus;
  createdAt: ISODateTime;
}

export interface AssistantMessageContext {
  message_id: string;
  sender_type: MessageSenderType | "ai";
  text: string;
  occurred_at: ISODateTime;
}

export interface AssistantSuggestRequest {
  contract: "C4.AssistantSuggestRequest";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  conversation_id?: string;
  requester_user_id?: string;
  query: string;
  context?: {
    messages: AssistantMessageContext[];
  };
}

export interface AssistantSource {
  source_type: "knowledge_chunk" | "none";
  title: string;
  document_id?: string;
  chunk_id?: string;
  excerpt?: string;
}

export interface AssistantSuggestResponse {
  contract: "C4.AssistantSuggestResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  degraded: boolean;
  fallback_reason: "timeout" | "unavailable" | null;
  suggestion: {
    mode: "deterministic_mock" | "fallback";
    text: string;
    confidence: number;
  };
  source_status: "available" | "not_available_m0" | "unavailable";
  sources: AssistantSource[];
  created_at: ISODateTime;
}

export type C7EventType =
  | "message.created"
  | "message.status_changed"
  | "typing.started"
  | "typing.stopped"
  | "client.status_changed"
  | "notification.created";

interface C7EventEnvelope<TEvent extends C7EventType, TPayload> {
  contract: "C7.WebSocketEvent";
  version: "1.0.0";
  event: TEvent;
  event_id: string;
  organization_id: string;
  subscription_id?: string;
  sequence_number: number;
  payload: TPayload;
  occurred_at: ISODateTime;
}

export type C7Event =
  | C7EventEnvelope<
      "message.created",
      {
        message: Message;
      }
    >
  | C7EventEnvelope<
      "message.status_changed",
      {
        message_id: string;
        conversation_id: string;
        status: MessageStatus;
      }
    >
  | C7EventEnvelope<
      "typing.started" | "typing.stopped",
      {
        conversation_id: string;
        client_id: string;
      }
    >
  | C7EventEnvelope<
      "client.status_changed",
      {
        client_id: string;
        status: ClientPresenceStatus;
      }
    >
  | C7EventEnvelope<
      "notification.created",
      {
        notification: NotificationItem;
      }
    >;

export interface ManagerWorkspaceApiClient {
  auth: {
    getSession: () => Promise<ManagerSession>;
    startTelegramLogin: (request: TelegramLoginStartRequest) => Promise<TelegramLoginStartResponse>;
    verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => Promise<ManagerSession>;
    logout: () => Promise<void>;
  };
  conversations: {
    list: () => Promise<Conversation[]>;
    get: (conversationId: string) => Promise<Conversation>;
    listMessages: (conversationId: string) => Promise<Message[]>;
  };
  messages: {
    create: (request: SendMessageRequest) => Promise<Message>;
    get: (messageId: string) => Promise<Message>;
  };
  clients: {
    list: () => Promise<ClientProfile[]>;
    get: (clientId: string) => Promise<ClientProfile>;
  };
  notifications: {
    list: () => Promise<NotificationItem[]>;
    markRead: (notificationId: string) => Promise<NotificationItem>;
  };
  ai: {
    suggest: (request: AssistantSuggestRequest) => Promise<AssistantSuggestResponse>;
  };
}
