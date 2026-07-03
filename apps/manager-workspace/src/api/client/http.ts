import { createJsonApiClient } from "@bridge/api-client";
import type {
  AssistantSuggestRequest,
  AssistantSuggestResponse,
  ClientProfile,
  Conversation,
  ManagerSession,
  ManagerWorkspaceApiClient,
  Message,
  NotificationItem,
  SendMessageRequest,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest
} from "./types";

export interface ManagerWorkspaceApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "/api/v1";

export function createManagerWorkspaceApiClient(
  options: ManagerWorkspaceApiClientOptions = {}
): ManagerWorkspaceApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetcher: options.fetcher
  });

  return {
    auth: {
      getSession: () => requestJson<ManagerSession>("/auth/session"),
      startTelegramLogin: (request: TelegramLoginStartRequest) =>
        requestJson<TelegramLoginStartResponse>("/auth/login/telegram/start", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      verifyTelegramLogin: (request: TelegramLoginVerifyRequest) =>
        requestJson<ManagerSession>("/auth/login/telegram/verify", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      logout: () =>
        requestJson<void>("/auth/logout", {
          method: "POST"
        })
    },
    conversations: {
      list: () => requestJson<Conversation[]>("/conversations"),
      get: (conversationId: string) => requestJson<Conversation>(`/conversations/${conversationId}`),
      listMessages: (conversationId: string) =>
        requestJson<Message[]>(`/conversations/${conversationId}/messages`)
    },
    messages: {
      create: (request: SendMessageRequest) =>
        requestJson<Message>("/messages", {
          method: "POST",
          body: JSON.stringify(request)
        }),
      get: (messageId: string) => requestJson<Message>(`/messages/${messageId}`)
    },
    clients: {
      list: () => requestJson<ClientProfile[]>("/clients"),
      get: (clientId: string) => requestJson<ClientProfile>(`/clients/${clientId}`)
    },
    notifications: {
      list: () => requestJson<NotificationItem[]>("/notifications"),
      markRead: (notificationId: string) =>
        requestJson<NotificationItem>(`/notifications/${notificationId}:read`, {
          method: "POST"
        })
    },
    ai: {
      suggest: (request: AssistantSuggestRequest) =>
        requestJson<AssistantSuggestResponse>("/ai/assistant:suggest", {
          method: "POST",
          body: JSON.stringify(request)
        })
    }
  };
}
