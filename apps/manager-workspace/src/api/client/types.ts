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

export type C7Event =
  | {
      type: "message.created";
      sequenceNumber: number;
      payload: {
        message: Message;
      };
    }
  | {
      type: "message.status_changed";
      sequenceNumber: number;
      payload: {
        messageId: string;
        conversationId: string;
        status: MessageStatus;
      };
    }
  | {
      type: "typing.started" | "typing.stopped";
      sequenceNumber: number;
      payload: {
        conversationId: string;
        clientId: string;
      };
    }
  | {
      type: "client.status_changed";
      sequenceNumber: number;
      payload: {
        clientId: string;
        status: "online" | "offline";
      };
    }
  | {
      type: "notification.created";
      sequenceNumber: number;
      payload: {
        notification: NotificationItem;
      };
    };

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
}
