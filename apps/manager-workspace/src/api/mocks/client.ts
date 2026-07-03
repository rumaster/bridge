import { createMockC7RealtimeClient } from "../client/realtime";
import type { ManagerWorkspaceApiClient } from "../client/types";
import { createMockManagerWorkspaceBackend } from "./backend";
import { mockC7Events } from "./fixtures";

export function createMockManagerWorkspaceApiClient(): ManagerWorkspaceApiClient {
  const backend = createMockManagerWorkspaceBackend();

  return {
    auth: {
      async getSession() {
        return backend.getSession();
      },
      async startTelegramLogin(request) {
        return backend.startTelegramLogin(request);
      },
      async verifyTelegramLogin(request) {
        return backend.verifyTelegramLogin(request);
      },
      async logout() {
        backend.logout();
      }
    },
    conversations: {
      async list() {
        return backend.listConversations();
      },
      async get(conversationId: string) {
        return backend.getConversation(conversationId);
      },
      async listMessages(conversationId: string) {
        return backend.listMessages(conversationId);
      }
    },
    messages: {
      async create(request) {
        return backend.createMessage(request);
      },
      async get(messageId: string) {
        return backend.getMessage(messageId);
      }
    },
    clients: {
      async list() {
        return backend.listClients();
      },
      async get(clientId: string) {
        return backend.getClient(clientId);
      }
    },
    notifications: {
      async list() {
        return backend.listNotifications();
      },
      async markRead(notificationId: string) {
        return backend.markNotificationRead(notificationId);
      }
    },
    ai: {
      async suggest(request) {
        return backend.suggestAssistant(request);
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
