import type {
  AssistantSuggestRequest,
  AssistantSuggestResponse,
  ClientProfile,
  Conversation,
  ManagerSession,
  Message,
  NotificationItem,
  SendMessageRequest,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest
} from "../client/types";
import {
  mockClients,
  mockConversations,
  mockMessages,
  mockNotifications,
  mockSession
} from "./fixtures";

export interface MockManagerWorkspaceBackend {
  getSession: () => ManagerSession;
  startTelegramLogin: (request: TelegramLoginStartRequest) => TelegramLoginStartResponse;
  verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => ManagerSession;
  logout: () => void;
  listConversations: () => Conversation[];
  getConversation: (conversationId: string) => Conversation;
  listMessages: (conversationId: string) => Message[];
  createMessage: (request: SendMessageRequest) => Message;
  getMessage: (messageId: string) => Message;
  downloadAttachment: (attachmentId: string) => Blob;
  listClients: () => ClientProfile[];
  getClient: (clientId: string) => ClientProfile;
  listNotifications: () => NotificationItem[];
  markNotificationRead: (notificationId: string) => NotificationItem;
  suggestAssistant: (request: AssistantSuggestRequest) => AssistantSuggestResponse;
}

export function createMockManagerWorkspaceBackend(): MockManagerWorkspaceBackend {
  let session: ManagerSession | null = copySession(mockSession);
  const conversations = mockConversations.map(copyConversation);
  const clients = mockClients.map(copyClient);
  const messages = mockMessages.map(copyMessage);
  const notifications = mockNotifications.map(copyNotification);
  const messagesByIdempotencyKey = new Map<string, Message>();

  return {
    getSession() {
      if (!session) {
        throw new MockBackendError("Session not found", 401);
      }

      return copySession(session);
    },
    startTelegramLogin(request) {
      if (!request.telegramUsername.trim()) {
        throw new MockBackendError("telegramUsername is required", 400);
      }

      return {
        requestId: "telegram-login-request-1",
        delivery: "telegram",
        expiresAt: "2026-07-02T16:20:00.000Z"
      };
    },
    verifyTelegramLogin(request) {
      if (!request.requestId || !request.code.trim()) {
        throw new MockBackendError("requestId and code are required", 400);
      }

      session = copySession(mockSession);
      return copySession(session);
    },
    logout() {
      session = null;
    },
    listConversations() {
      return [...conversations]
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
        .map(copyConversation);
    },
    getConversation(conversationId) {
      return copyConversation(findConversation(conversations, conversationId));
    },
    listMessages(conversationId) {
      findConversation(conversations, conversationId);
      return messages
        .filter((message) => message.conversationId === conversationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(copyMessage);
    },
    createMessage(request) {
      validateSendMessageRequest(request, conversations);

      const existingMessage = messagesByIdempotencyKey.get(request.idempotencyKey);
      if (existingMessage) {
        return copyMessage(existingMessage);
      }

      const conversation = findConversation(conversations, request.conversationId);
      const createdAt = "2026-07-02T16:12:00.000Z";
      const message: Message = {
        id: `msg-${request.idempotencyKey}`,
        conversationId: request.conversationId,
        channel: conversation.channel,
        direction: "outbound",
        senderType: "manager",
        content: request.content.trim(),
        status: "sent",
        createdAt
      };

      messages.push(message);
      messagesByIdempotencyKey.set(request.idempotencyKey, message);
      conversation.lastMessageAt = createdAt;
      conversation.lastMessagePreview = message.content;
      conversation.unreadCount = 0;

      return copyMessage(message);
    },
    getMessage(messageId) {
      const message = messages.find((item) => item.id === messageId);

      if (!message) {
        throw new MockBackendError("Message not found", 404);
      }

      return copyMessage(message);
    },
    downloadAttachment(attachmentId) {
      const owner = messages.find((message) =>
        message.attachments?.some((attachment) => attachment.id === attachmentId)
      );
      const attachment = owner?.attachments?.find((item) => item.id === attachmentId);
      if (!attachment) {
        throw new MockBackendError("Attachment not found", 404);
      }
      // Мок отдаёт детерминированные «байты» — по имени вложения.
      return new Blob([`mock-bytes:${attachment.name}`], {
        type: attachment.contentType || "application/octet-stream"
      });
    },
    listClients() {
      return clients.map(copyClient);
    },
    getClient(clientId) {
      const client = clients.find((item) => item.id === clientId);

      if (!client) {
        throw new MockBackendError("Client not found", 404);
      }

      return copyClient(client);
    },
    listNotifications() {
      return notifications.map(copyNotification);
    },
    markNotificationRead(notificationId) {
      const notification = notifications.find((item) => item.id === notificationId);

      if (!notification) {
        throw new MockBackendError("Notification not found", 404);
      }

      notification.status = "read";
      return copyNotification(notification);
    },
    suggestAssistant(request) {
      validateAssistantSuggestRequest(request);

      return {
        contract: "C4.AssistantSuggestResponse",
        version: "1.0.0",
        request_id: request.request_id,
        organization_id: request.organization_id,
        degraded: false,
        fallback_reason: null,
        suggestion: {
          mode: "generated",
          text:
            "Поблагодарите клиента за ожидание, уточните номер заказа и сообщите, что статус доставки проверяется по базе знаний.",
          confidence: 0.72
        },
        source_status: "available",
        sources: [
          {
            source_type: "knowledge_chunk",
            document_id: "kb-order-delivery",
            chunk_id: "kb-order-delivery-status",
            title: "KB: статусы доставки заказов",
            excerpt: "Перед обещанием срока менеджер проверяет актуальный статус заказа и доставки."
          }
        ],
        created_at: "2026-07-02T16:12:30.000Z"
      };
    }
  };
}

export class MockBackendError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "MockBackendError";
  }
}

function validateSendMessageRequest(request: SendMessageRequest, conversations: Conversation[]) {
  findConversation(conversations, request.conversationId);

  if (!request.content.trim()) {
    throw new MockBackendError("content is required", 400);
  }

  if (!request.idempotencyKey.trim()) {
    throw new MockBackendError("idempotencyKey is required", 400);
  }
}

function validateAssistantSuggestRequest(request: AssistantSuggestRequest) {
  if (request.contract !== "C4.AssistantSuggestRequest" || request.version !== "1.0.0") {
    throw new MockBackendError("C4 assistant contract/version is invalid", 400);
  }

  if (!request.request_id.trim() || !request.organization_id.trim() || !request.query.trim()) {
    throw new MockBackendError("request_id, organization_id and query are required", 400);
  }
}

function findConversation(conversations: Conversation[], conversationId: string) {
  const conversation = conversations.find((item) => item.id === conversationId);

  if (!conversation) {
    throw new MockBackendError("Conversation not found", 404);
  }

  return conversation;
}

function copySession(session: ManagerSession): ManagerSession {
  return {
    ...session,
    user: { ...session.user },
    organization: { ...session.organization }
  };
}

function copyConversation(conversation: Conversation): Conversation {
  return { ...conversation };
}

function copyMessage(message: Message): Message {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment }))
  };
}

function copyClient(client: ClientProfile): ClientProfile {
  return {
    ...client,
    tags: [...client.tags],
    notes: [...client.notes],
    endpoints: client.endpoints.map((endpoint) => ({ ...endpoint }))
  };
}

function copyNotification(notification: NotificationItem): NotificationItem {
  return { ...notification };
}
