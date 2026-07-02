import { createMockC7RealtimeClient } from "../client/realtime";
import type {
  ManagerWorkspaceApiClient,
  Message,
  NotificationItem,
  SendMessageRequest,
  TelegramLoginStartRequest,
  TelegramLoginVerifyRequest
} from "../client/types";
import {
  mockC7Events,
  mockClients,
  mockConversations,
  mockMessages,
  mockNotifications,
  mockSession
} from "./fixtures";

export function createMockManagerWorkspaceApiClient(): ManagerWorkspaceApiClient {
  return {
    auth: {
      async getSession() {
        return mockSession;
      },
      async startTelegramLogin(request: TelegramLoginStartRequest) {
        if (!request.telegramUsername) {
          throw new Error("telegramUsername is required");
        }

        return {
          requestId: "telegram-login-request-1",
          delivery: "telegram",
          expiresAt: "2026-07-02T16:20:00.000Z"
        };
      },
      async verifyTelegramLogin(request: TelegramLoginVerifyRequest) {
        if (!request.requestId || !request.code) {
          throw new Error("requestId and code are required");
        }

        return mockSession;
      },
      async logout() {
        return undefined;
      }
    },
    conversations: {
      async list() {
        return [...mockConversations];
      },
      async get(conversationId: string) {
        const conversation = mockConversations.find((item) => item.id === conversationId);

        if (!conversation) {
          throw new Error("Conversation not found");
        }

        return conversation;
      },
      async listMessages(conversationId: string) {
        return mockMessages.filter((message) => message.conversationId === conversationId);
      }
    },
    messages: {
      async create(request: SendMessageRequest) {
        const message: Message = {
          id: `msg-${request.idempotencyKey}`,
          conversationId: request.conversationId,
          channel: "web_chat",
          direction: "outbound",
          senderType: "manager",
          content: request.content,
          status: "sent",
          createdAt: "2026-07-02T16:12:00.000Z"
        };

        return message;
      },
      async get(messageId: string) {
        const message = mockMessages.find((item) => item.id === messageId);

        if (!message) {
          throw new Error("Message not found");
        }

        return message;
      }
    },
    clients: {
      async list() {
        return [...mockClients];
      },
      async get(clientId: string) {
        const client = mockClients.find((item) => item.id === clientId);

        if (!client) {
          throw new Error("Client not found");
        }

        return client;
      }
    },
    notifications: {
      async list() {
        return [...mockNotifications];
      },
      async markRead(notificationId: string) {
        const notification = mockNotifications.find((item) => item.id === notificationId);

        if (!notification) {
          throw new Error("Notification not found");
        }

        return { ...notification, status: "read" } satisfies NotificationItem;
      }
    }
  };
}

export function createMockManagerWorkspaceServices() {
  return {
    api: createMockManagerWorkspaceApiClient(),
    realtime: createMockC7RealtimeClient(mockC7Events)
  };
}
