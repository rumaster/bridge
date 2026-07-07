import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_BASE_URL = "http://localhost:3000/api/v1";
const ORGANIZATION_ID_HEADER = "x-organization-id";
const ACTOR_USER_ID_HEADER = "x-actor-user-id";
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export class TelegramConsoleBackendApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;

  constructor(message: string, { status, body, url }: any) {
    super(message);
    this.name = "TelegramConsoleBackendApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function createTelegramConsoleBackendApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetcher = getGlobalFetch(),
}: any = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const sessionContext = new AsyncLocalStorage<any>();
  const sessionsByToken = new Map();
  const endpointIdByConversationId = new Map();
  const activeConversationBySessionToken = new Map();

  const api = {
    auth: {
      async startTelegramLogin(request: any = {}) {
        const response = await requestJson("/auth/login/telegram/start", {
          method: "POST",
          body: {
            telegramUsername: readTelegramUsername(request),
          },
          auth: false,
        });

        return {
          ...response,
          request_id: response.request_id ?? response.requestId,
          expires_at: response.expires_at ?? response.expiresAt,
        };
      },

      async verifyTelegramLogin(request: any = {}) {
        const response = await requestJson("/auth/login/telegram/verify", {
          method: "POST",
          body: {
            requestId: request.requestId ?? request.request_id,
            code: request.code,
            telegramUsername: readTelegramUsername(request),
          },
          auth: false,
        });
        const session = normalizeSession(response);
        sessionsByToken.set(session.token, session);
        return session;
      },

      async getSession({ token }: any = {}) {
        const cached = sessionsByToken.get(token);
        const response = await requestJson("/auth/session", {
          auth: sessionHeaders(cached ?? { token }),
        });
        const session = normalizeSession(response);
        sessionsByToken.set(session.token, session);
        return session;
      },

      async logout({ token }: any = {}) {
        const cached = sessionsByToken.get(token);
        await requestJson("/auth/logout", {
          method: "POST",
          auth: sessionHeaders(cached ?? { token }),
        });
        sessionsByToken.delete(token);
        activeConversationBySessionToken.delete(token);
        return { logged_out: true };
      },
    },

    conversations: {
      async list() {
        const response = await requestJson("/conversations", {
          auth: currentSessionHeaders(),
        });
        return extractItems(response).map(normalizeConversation);
      },

      async get(conversationId) {
        const conversation = normalizeConversation(
          await requestJson(`/conversations/${encodeURIComponent(conversationId)}`, {
            auth: currentSessionHeaders(),
          }),
        );
        return conversation;
      },

      async listMessages(conversationId) {
        const response = await requestJson(
          `/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            auth: currentSessionHeaders(),
          },
        );
        return extractItems(response).map((message) =>
          normalizeMessage(message, { idempotencyKey: message.idempotency_key }),
        );
      },
    },

    clients: {
      async get(clientId) {
        return normalizeClient(
          await requestJson(`/clients/${encodeURIComponent(clientId)}`, {
            auth: currentSessionHeaders(),
          }),
        );
      },
    },

    messages: {
      async create(request: any = {}) {
        const organizationId = stringValue(request.organization_id ?? currentSession()?.organization?.id);
        const actorUserId = stringValue(currentSession()?.user?.id);
        const conversationId = stringValue(request.conversation_id ?? request.conversationId);
        const idempotencyKey = stringValue(request.idempotency_key ?? request.idempotencyKey);
        const endpointId = stringValue(request.endpoint_id ?? request.endpointId) ||
          (await resolveEndpointId(conversationId));

        const response = await requestJson("/messages", {
          method: "POST",
          body: {
            conversationId,
            endpointId,
            direction: "outbound",
            senderType: request.sender_type ?? request.senderType ?? "manager",
            type: request.type ?? "text",
            content: request.content,
          },
          auth: {
            ...currentSessionHeaders({ organizationId }),
            ...(actorUserId ? { [ACTOR_USER_ID_HEADER]: actorUserId } : {}),
            [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
          },
        });

        return normalizeMessage(response, { idempotencyKey });
      },
    },

    notifications: {
      async list(query: any = {}) {
        const search = new URLSearchParams();
        for (const key of ["status", "category", "cursor", "limit"]) {
          if (query[key] !== undefined && query[key] !== null) {
            search.set(key, String(query[key]));
          }
        }
        const suffix = search.size > 0 ? `?${search}` : "";
        const response = await requestJson(`/notifications${suffix}`, {
          auth: currentSessionHeaders(),
        });
        return normalizeNotificationList(response);
      },

      async markRead(notificationId) {
        const response = await requestJson(
          `/notifications/${encodeURIComponent(notificationId)}:read`,
          {
            method: "POST",
            auth: currentSessionHeaders(),
          },
        );
        return normalizeNotification(response.notification ?? response);
      },
    },

    ai: {
      async suggest(request: any = {}) {
        return requestJson("/ai/assistant:suggest", {
          method: "POST",
          body: {
            query: request.query,
          },
          auth: currentSessionHeaders({
            organizationId: request.organization_id,
          }),
        });
      },
    },

    telegramConsole: {
      async setActiveConversation({ session_token, conversation_id }: any = {}) {
        const token = stringValue(session_token);
        activeConversationBySessionToken.set(token, conversation_id);
        return {
          contract: "TGC.ActiveConversationState",
          version: "1.0.0",
          conversation_id,
          updated_at: new Date().toISOString(),
          storage: "telegram-console-local",
        };
      },

      async getActiveConversation({ session_token }: any = {}) {
        const token = stringValue(session_token);
        return {
          contract: "TGC.ActiveConversationState",
          version: "1.0.0",
          conversation_id: activeConversationBySessionToken.get(token) ?? null,
          restored_from: "telegram-console-local",
        };
      },
    },

    async withSession(session, operation) {
      const normalized = normalizeSession(session);
      sessionsByToken.set(normalized.token, normalized);
      return sessionContext.run(normalized, operation);
    },
  };

  return api;

  async function resolveEndpointId(conversationId) {
    const cached = endpointIdByConversationId.get(conversationId);
    if (cached) {
      return cached;
    }

    const messages = await api.conversations.listMessages(conversationId);
    const endpointId = messages.find((message) => isNonEmptyString(message.endpoint_id))?.endpoint_id;
    if (!endpointId) {
      throw new TelegramConsoleBackendApiError(
        `Cannot resolve endpointId for conversation ${conversationId}`,
        { status: 400, body: null, url: resolveApiUrl(normalizedBaseUrl, "/messages") },
      );
    }

    return endpointId;
  }

  async function requestJson(path, { method = "GET", body, auth = true }: any = {}) {
    const url = resolveApiUrl(normalizedBaseUrl, path);
    const headers = new Headers();
    headers.set("Accept", "application/json");

    const authHeaders =
      auth === false
        ? {}
        : auth === true
          ? currentSessionHeaders()
          : auth;
    appendHeaders(headers, authHeaders);

    const init = { method, headers } as any;
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }

    const response = await fetcher(url, init);
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw new TelegramConsoleBackendApiError(errorMessage(responseBody, response.status), {
        status: response.status,
        body: responseBody,
        url,
      });
    }

    return responseBody;
  }

  function currentSessionHeaders({ organizationId }: any = {}) {
    return sessionHeaders(currentSession(), { organizationId });
  }

  function currentSession() {
    return sessionContext.getStore();
  }

  function sessionHeaders(session, { organizationId }: any = {}) {
    if (!session?.token) {
      throw new TelegramConsoleBackendApiError("Backend session is required", {
        status: 401,
        body: null,
        url: normalizedBaseUrl,
      });
    }

    const headers = {
      Authorization: `Bearer ${session.token}`,
    };
    const resolvedOrganizationId = stringValue(organizationId ?? session.organization?.id);
    if (resolvedOrganizationId) {
      headers[ORGANIZATION_ID_HEADER] = resolvedOrganizationId;
    }

    return headers;
  }

  function normalizeMessage(message, { idempotencyKey = null } = {}) {
    const normalized = {
      id: stringValue(message.id),
      organization_id: stringValue(message.organization_id ?? message.organizationId),
      conversation_id: stringValue(message.conversation_id ?? message.conversationId),
      endpoint_id: stringValue(message.endpoint_id ?? message.endpointId),
      channel: stringValue(message.channel, "web_chat"),
      direction: stringValue(message.direction, "outbound"),
      sender_type: stringValue(message.sender_type ?? message.senderType, "manager"),
      sequence_number: numberValue(message.sequence_number ?? message.sequenceNumber, 0),
      type: stringValue(message.type, "text"),
      content: normalizeMessageContent(message.content),
      status: stringValue(message.status, "routed"),
      created_at: stringValue(message.created_at ?? message.createdAt, new Date(0).toISOString()),
      delivered_at: message.delivered_at ?? message.deliveredAt ?? null,
      idempotency_key: stringValue(message.idempotency_key ?? message.idempotencyKey ?? idempotencyKey),
    };

    if (normalized.conversation_id && normalized.endpoint_id) {
      endpointIdByConversationId.set(normalized.conversation_id, normalized.endpoint_id);
    }

    return normalized;
  }
}

function normalizeSession(session: any) {
  return {
    token: stringValue(session?.token),
    user: {
      id: stringValue(session?.user?.id),
      display_name: stringValue(session?.user?.display_name ?? session?.user?.displayName),
      role: stringValue(session?.user?.role, "manager"),
      telegram_username: stringValue(
        session?.user?.telegram_username ?? session?.user?.telegramUsername,
      ),
    },
    organization: {
      id: stringValue(session?.organization?.id),
      name: stringValue(session?.organization?.name),
    },
    expires_at: stringValue(session?.expires_at ?? session?.expiresAt),
    revoked_at: session?.revoked_at ?? session?.revokedAt ?? null,
  };
}

function normalizeConversation(conversation: any) {
  return {
    id: stringValue(conversation.id),
    organization_id: stringValue(conversation.organization_id ?? conversation.organizationId),
    client_id: stringValue(conversation.client_id ?? conversation.clientId),
    status: stringValue(conversation.status, "open"),
    channel: stringValue(conversation.channel, "web_chat"),
    last_message_at: stringValue(
      conversation.last_message_at ?? conversation.lastMessageAt ?? conversation.updatedAt,
      new Date(0).toISOString(),
    ),
    last_message_preview: stringValue(
      conversation.last_message_preview ?? conversation.lastMessagePreview,
    ),
    unread_count: numberValue(conversation.unread_count ?? conversation.unreadCount, 0),
  };
}

function normalizeClient(client: any) {
  return {
    id: stringValue(client.id),
    organization_id: stringValue(client.organization_id ?? client.organizationId),
    display_name: stringValue(client.display_name ?? client.displayName, "Клиент без имени"),
    status: client.status ?? null,
    tags: arrayValue(client.tags).map((tag) => String(tag)),
    notes: arrayValue(client.notes).map((note) => String(note)),
    endpoints: arrayValue(client.endpoints).map((endpoint) => ({
      id: stringValue(endpoint.id),
      channel: stringValue(endpoint.channel),
      external_id: stringValue(endpoint.external_id ?? endpoint.externalId),
      display_name: stringValue(endpoint.display_name ?? endpoint.displayName),
    })),
  };
}

function normalizeNotificationList(response: any) {
  return extractItems(response).map(normalizeNotification);
}

function normalizeNotification(notification: any) {
  return {
    ...notification,
    created_at: notification.created_at ?? notification.createdAt,
    read_at: notification.read_at ?? notification.readAt ?? null,
  };
}

function normalizeMessageContent(content: any) {
  if (typeof content === "string") {
    return { text: content };
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content;
  }
  return { text: "" };
}

function readTelegramUsername(request: any) {
  return stringValue(
    request.telegramUsername ??
      request.telegram_username ??
      request.telegram_user?.username ??
      request.telegramUser?.username,
  );
}

function extractItems(response: any) {
  return Array.isArray(response) ? response : arrayValue(response?.items);
}

async function readResponseBody(response: any) {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text === "" ? undefined : text;
}

function appendHeaders(target: Headers, source: any) {
  new Headers(source).forEach((value, key) => {
    target.set(key, value);
  });
}

function resolveApiUrl(baseUrl: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

function normalizeBaseUrl(baseUrl: string) {
  if (!isNonEmptyString(baseUrl)) {
    throw new TypeError("baseUrl must be a non-empty string");
  }
  return baseUrl.replace(/\/+$/, "");
}

function errorMessage(body: any, status: number) {
  if (body && typeof body === "object") {
    return body.message ?? body.detail ?? body.description ?? `Backend API request failed with ${status}`;
  }
  return `Backend API request failed with ${status}`;
}

function arrayValue(value: any) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: any, fallback = "") {
  return isNonEmptyString(value) ? value : fallback;
}

function numberValue(value: any, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isNonEmptyString(value: any) {
  return typeof value === "string" && value.trim() !== "";
}

function getGlobalFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("fetcher option is required when global fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis);
}
