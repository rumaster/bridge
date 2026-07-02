import type {
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

interface ApiErrorBody {
  message?: string;
}

const DEFAULT_BASE_URL = "/api/v1";

export function createManagerWorkspaceApiClient(
  options: ManagerWorkspaceApiClientOptions = {}
): ManagerWorkspaceApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

  async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(resolveUrl(baseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers
      }
    });

    if (!response.ok) {
      let body: ApiErrorBody = {};
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        body = {};
      }

      throw new Error(body.message ?? `Backend API request failed with ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

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
    }
  };
}

function resolveUrl(baseUrl: string, path: string): string {
  const origin = globalThis.location?.origin ?? "http://localhost";
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;

  return new URL(normalizedPath, new URL(normalizedBase, origin)).toString();
}
