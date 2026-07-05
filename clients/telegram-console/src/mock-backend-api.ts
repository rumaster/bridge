// Array.prototype.toSorted is available at runtime (Node 20+) but is part of
// the ES2023 lib, which this workspace's ES2022 lib target does not declare.
declare global {
  interface Array<T> {
    toSorted(compareFn?: (a: T, b: T) => number): T[];
  }
}

const DEFAULT_ORGANIZATION_ID = "org-1";
const DEFAULT_MANAGER_ID = "manager-1";
const DEFAULT_MANAGER_USERNAME = "manager_demo";

export interface TelegramUserRef {
  id?: number | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export interface StartTelegramLoginRequest {
  telegram_username?: string;
  telegramUsername?: string;
  telegram_user?: TelegramUserRef | null;
  chat_id?: number | null;
}

export interface VerifyTelegramLoginRequest {
  request_id?: string;
  code?: string;
  telegram_username?: string;
  telegram_user?: TelegramUserRef | null;
  chat_id?: number | null;
}

export interface SessionTokenRequest {
  token?: string;
}

export interface CreateManagerMessageRequest {
  idempotency_key?: string;
  organization_id?: string;
  conversation_id?: string;
  sender_type?: string;
  type?: string;
  content?: { text: string };
}

export interface AssistantSuggestRequest {
  contract?: string;
  version?: string;
  request_id?: string;
  organization_id?: string;
  query?: string;
}

export interface ActiveConversationRequest {
  session_token?: string;
  conversation_id?: string;
}

export function createMockTelegramConsoleBackendApi({
  now = () => new Date().toISOString(),
  aiAvailable = true,
} = {}) {
  const recordedRequests = [];
  const messagesByIdempotencyKey = new Map();
  const loginRequestsById = new Map();
  const sessionsByToken = new Map();
  const activeConversationByToken = new Map();
  const conversations = createConversations();
  const messages = createMessages();
  const notifications = createNotifications(now);

  const backend = {
    auth: {
      async startTelegramLogin(request: StartTelegramLoginRequest = {}) {
        record("POST", "/auth/login/telegram/start", request);
        const telegramUsername = request.telegram_username ?? request.telegramUsername;
        if (!isNonEmptyString(telegramUsername)) {
          throw new MockBackendApiError("telegram username is required", 400);
        }
        const user = findManagerByTelegramUsername(telegramUsername);
        if (!user) {
          throw new MockBackendApiError("telegram account is not linked to a manager", 403);
        }

        const requestId = `telegram-login-request-${loginRequestsById.size + 1}`;
        loginRequestsById.set(requestId, {
          request_id: requestId,
          telegram_username: normalizeUsername(telegramUsername),
          telegram_user_id: request.telegram_user?.id ?? null,
          chat_id: request.chat_id ?? null,
        });

        return {
          request_id: requestId,
          delivery: "telegram",
          expires_at: addMs(now(), 5 * 60_000),
          proxied_to: "C3.auth",
          upstream_operation: "POST /auth/login/telegram/start",
          mock: true,
        };
      },

      async verifyTelegramLogin(request: VerifyTelegramLoginRequest = {}) {
        record("POST", "/auth/login/telegram/verify", request);
        if (!isNonEmptyString(request.request_id) || !isNonEmptyString(request.code)) {
          throw new MockBackendApiError("request_id and code are required", 400);
        }
        const loginRequest = loginRequestsById.get(request.request_id);
        if (!loginRequest) {
          throw new MockBackendApiError("telegram login request not found", 404);
        }
        assertSameTelegramUser(loginRequest, request);

        const session = createSession(now, {
          telegram_username: loginRequest.telegram_username,
          telegram_user_id: loginRequest.telegram_user_id,
          chat_id: loginRequest.chat_id,
        });
        sessionsByToken.set(session.token, clone(session));
        return clone(session);
      },

      async getSession({ token }: SessionTokenRequest = {}) {
        record("GET", "/auth/session", { token });
        const session = sessionsByToken.get(token);
        if (!session) {
          throw new MockBackendApiError("session not found", 401);
        }
        if (isSessionEnded(session, now())) {
          throw new MockBackendApiError("session expired or revoked", 401);
        }
        return clone({
          ...session,
          telegram_console: {
            active_conversation_id: activeConversationByToken.get(token) ?? null,
          },
        });
      },

      async logout({ token }: SessionTokenRequest = {}) {
        record("POST", "/auth/logout", { token });
        const session = sessionsByToken.get(token);
        if (!session) {
          return { logged_out: true, session_mode: "missing" };
        }
        session.revoked_at = now();
        activeConversationByToken.delete(token);
        return { logged_out: true, session_mode: "server", revoked_at: session.revoked_at };
      },

      revokeSession(token) {
        const session = sessionsByToken.get(token);
        if (session) {
          session.revoked_at = now();
          activeConversationByToken.delete(token);
        }
      },
    },

    conversations: {
      async list() {
        record("GET", "/conversations");
        return conversations
          .toSorted((left, right) => right.last_message_at.localeCompare(left.last_message_at))
          .map(clone);
      },

      async get(conversationId) {
        record("GET", `/conversations/${conversationId}`);
        return clone(findById(conversations, conversationId, "Conversation"));
      },

      async listMessages(conversationId) {
        record("GET", `/conversations/${conversationId}/messages`);
        findById(conversations, conversationId, "Conversation");
        return messages
          .filter((message) => message.conversation_id === conversationId)
          .toSorted((left, right) => left.created_at.localeCompare(right.created_at))
          .map(clone);
      },
    },

    clients: {
      async get(clientId) {
        record("GET", `/clients/${clientId}`);
        return clone(findById(CLIENTS, clientId, "Client"));
      },
    },

    messages: {
      async create(request: CreateManagerMessageRequest = {}) {
        record("POST", "/messages", request);
        validateManagerMessageRequest(request);

        const existing = messagesByIdempotencyKey.get(request.idempotency_key);
        if (existing) {
          return clone(existing);
        }

        const conversation = findById(conversations, request.conversation_id, "Conversation");
        const createdAt = now();
        const message = {
          id: `msg-${request.idempotency_key}`,
          organization_id: request.organization_id,
          conversation_id: request.conversation_id,
          endpoint_id: conversation.endpoint_id,
          channel: conversation.channel,
          direction: "outbound",
          sender_type: "manager",
          sequence_number: nextSequenceNumber(request.conversation_id, messages),
          type: request.type,
          content: { text: request.content.text.trim() },
          status: "sent",
          created_at: createdAt,
          delivered_at: null,
          idempotency_key: request.idempotency_key,
          duplicate: false,
        };

        messages.push(message);
        messagesByIdempotencyKey.set(request.idempotency_key, message);
        conversation.last_message_at = createdAt;
        conversation.last_message_preview = message.content.text;
        conversation.unread_count = 0;

        return clone(message);
      },
    },

    notifications: {
      async list() {
        record("GET", "/notifications");
        return clone({
          contract: "C10.ListNotificationsResponse",
          version: "1.0.0",
          request_id: "tgc-notifications-list-1",
          organization_id: DEFAULT_ORGANIZATION_ID,
          recipient_user_id: DEFAULT_MANAGER_ID,
          items: notifications,
          page: { next_cursor: null },
        });
      },

      async markRead(notificationId) {
        record("POST", `/notifications/${notificationId}:read`);
        const notification = findById(notifications, notificationId, "Notification");
        notification.status = "read";
        notification.read_at = now();
        return clone({
          contract: "C10.MarkNotificationReadResponse",
          version: "1.0.0",
          request_id: `tgc-notification-read-${notificationId}`,
          organization_id: DEFAULT_ORGANIZATION_ID,
          notification,
        });
      },
    },

    ai: {
      async suggest(request: AssistantSuggestRequest = {}) {
        record("POST", "/ai/assistant:suggest", request);
        if (!aiAvailable) {
          throw new MockBackendApiError("C4 AI unavailable", 503);
        }
        validateAssistantSuggestRequest(request);

        return {
          contract: "C4.AssistantSuggestResponse",
          version: "1.0.0",
          request_id: request.request_id,
          organization_id: request.organization_id,
          degraded: false,
          fallback_reason: null,
          suggestion: {
            mode: "deterministic_mock",
            text: createAiSuggestionText(request.query),
            confidence: 0.74,
          },
          source_status: "available",
          sources: [
            {
              source_type: "knowledge_chunk",
              document_id: "kb-order-delivery",
              chunk_id: "kb-order-delivery-status",
              title: "KB: статусы доставки",
              excerpt: "Перед обещанием срока менеджер проверяет актуальный статус заказа.",
            },
          ],
          created_at: now(),
        };
      },
    },

    telegramConsole: {
      async setActiveConversation({ session_token, conversation_id }: ActiveConversationRequest = {}) {
        record("PUT", "/telegram-console/active-conversation", {
          session_token,
          conversation_id,
        });
        assertActiveSession(session_token, sessionsByToken, now);
        findById(conversations, conversation_id, "Conversation");
        activeConversationByToken.set(session_token, conversation_id);
        return clone({
          contract: "TGC.ActiveConversationState",
          version: "1.0.0",
          conversation_id,
          updated_at: now(),
        });
      },

      async getActiveConversation({ session_token }: ActiveConversationRequest = {}) {
        record("GET", "/telegram-console/active-conversation", { session_token });
        assertActiveSession(session_token, sessionsByToken, now);
        return clone({
          contract: "TGC.ActiveConversationState",
          version: "1.0.0",
          conversation_id: activeConversationByToken.get(session_token) ?? null,
          restored_from: "Backend",
        });
      },
    },

    getRecordedRequests() {
      return recordedRequests.map(clone);
    },

    getFixtures() {
      return clone({
        conversations,
        clients: CLIENTS,
        messages,
        notifications,
        active_conversations: Object.fromEntries(activeConversationByToken),
      });
    },
  };

  return backend;

  function record(method, path, body = null) {
    recordedRequests.push({
      method,
      path,
      body: body === null ? null : clone(body),
      recorded_at: now(),
    });
  }
}

export class MockBackendApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MockBackendApiError";
    this.status = status;
  }
}

function createSession(now, { telegram_username, telegram_user_id, chat_id }) {
  return {
    contract: "TGC.ManagerSession",
    version: "1.0.0",
    token: "mock-manager-session",
    user: {
      id: DEFAULT_MANAGER_ID,
      display_name: "Демо Менеджер",
      role: "manager",
      telegram_username,
      telegram_user_id,
    },
    organization: {
      id: DEFAULT_ORGANIZATION_ID,
      name: "Bridge Demo",
    },
    chat_id,
    expires_at: addMs(now(), 8 * 60 * 60_000),
    created_at: now(),
    revoked_at: null,
    proxied_to: "C3.auth",
    upstream_operation: "POST /auth/login/telegram/verify",
    mock: true,
  };
}

function createConversations() {
  return [
    {
      id: "conv-1",
      organization_id: DEFAULT_ORGANIZATION_ID,
      client_id: "client-1",
      endpoint_id: "endpoint-1",
      status: "open",
      channel: "web_chat",
      last_message_at: "2026-07-03T22:39:00.000Z",
      last_message_preview: "Хочу уточнить статус заказа",
      unread_count: 2,
    },
    {
      id: "conv-2",
      organization_id: DEFAULT_ORGANIZATION_ID,
      client_id: "client-2",
      endpoint_id: "endpoint-2",
      status: "pending",
      channel: "telegram",
      last_message_at: "2026-07-03T22:33:00.000Z",
      last_message_preview: "Когда менеджер сможет ответить?",
      unread_count: 1,
    },
  ];
}

function createMessages() {
  return [
    {
      id: "msg-1",
      organization_id: DEFAULT_ORGANIZATION_ID,
      conversation_id: "conv-1",
      endpoint_id: "endpoint-1",
      channel: "web_chat",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 1,
      type: "text",
      content: { text: "Хочу уточнить статус заказа" },
      status: "received",
      created_at: "2026-07-03T22:38:20.000Z",
      delivered_at: null,
    },
    {
      id: "msg-2",
      organization_id: DEFAULT_ORGANIZATION_ID,
      conversation_id: "conv-1",
      endpoint_id: "endpoint-1",
      channel: "web_chat",
      direction: "outbound",
      sender_type: "manager",
      sequence_number: 2,
      type: "text",
      content: { text: "Здравствуйте, сейчас проверю." },
      status: "sent",
      created_at: "2026-07-03T22:38:50.000Z",
      delivered_at: null,
    },
    {
      id: "msg-3",
      organization_id: DEFAULT_ORGANIZATION_ID,
      conversation_id: "conv-2",
      endpoint_id: "endpoint-2",
      channel: "telegram",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 1,
      type: "text",
      content: { text: "Когда менеджер сможет ответить?" },
      status: "received",
      created_at: "2026-07-03T22:33:00.000Z",
      delivered_at: null,
    },
  ];
}

function createNotifications(now) {
  return [
    {
      contract: "C10.Notification",
      version: "1.0.0",
      id: "notif-1",
      organization_id: DEFAULT_ORGANIZATION_ID,
      recipient_user_id: DEFAULT_MANAGER_ID,
      category: "info",
      title: "Новый диалог в очереди",
      body: "Анна Петрова ожидает ответа менеджера.",
      payload: {
        conversation_id: "conv-1",
        client_id: "client-1",
      },
      status: "new",
      channels: ["web", "telegram"],
      created_at: now(),
      read_at: null,
      dedupe_key: "notif-conv-1",
    },
  ];
}

const CLIENTS = Object.freeze([
  {
    id: "client-1",
    organization_id: DEFAULT_ORGANIZATION_ID,
    display_name: "Анна Петрова",
    status: "offline",
    tags: ["vip", "web-chat"],
    notes: ["Предпочитает короткие ответы по статусам заказов."],
    endpoints: [
      {
        id: "endpoint-1",
        channel: "web_chat",
        external_id: "web-chat:anna",
        display_name: "Web Chat",
      },
    ],
  },
  {
    id: "client-2",
    organization_id: DEFAULT_ORGANIZATION_ID,
    display_name: "Илья Смирнов",
    status: "offline",
    tags: ["telegram"],
    notes: ["Ждет ответа после уточнения у склада."],
    endpoints: [
      {
        id: "endpoint-2",
        channel: "telegram",
        external_id: "telegram:ilya",
        display_name: "@ilya_demo",
      },
    ],
  },
]);

function findManagerByTelegramUsername(username) {
  if (normalizeUsername(username) !== normalizeUsername(DEFAULT_MANAGER_USERNAME)) {
    return null;
  }

  return {
    id: DEFAULT_MANAGER_ID,
    organization_id: DEFAULT_ORGANIZATION_ID,
    role: "manager",
    telegram_username: DEFAULT_MANAGER_USERNAME,
  };
}

function assertSameTelegramUser(loginRequest, verifyRequest) {
  const verifyUsername = normalizeUsername(
    verifyRequest.telegram_username ?? verifyRequest.telegram_user?.username,
  );
  if (verifyUsername && verifyUsername !== loginRequest.telegram_username) {
    throw new MockBackendApiError("telegram account ownership mismatch", 403);
  }

  const verifyUserId = verifyRequest.telegram_user?.id ?? null;
  if (
    loginRequest.telegram_user_id !== null &&
    verifyUserId !== null &&
    loginRequest.telegram_user_id !== verifyUserId
  ) {
    throw new MockBackendApiError("telegram account ownership mismatch", 403);
  }

  if (
    loginRequest.chat_id !== null &&
    verifyRequest.chat_id !== undefined &&
    loginRequest.chat_id !== verifyRequest.chat_id
  ) {
    throw new MockBackendApiError("telegram login chat mismatch", 403);
  }
}

function assertActiveSession(token, sessionsByToken, now) {
  if (!isNonEmptyString(token)) {
    throw new MockBackendApiError("session token is required", 401);
  }

  const session = sessionsByToken.get(token);
  if (!session) {
    throw new MockBackendApiError("session not found", 401);
  }
  if (isSessionEnded(session, now())) {
    throw new MockBackendApiError("session expired or revoked", 401);
  }
}

function validateManagerMessageRequest(
  request: CreateManagerMessageRequest,
): asserts request is Required<CreateManagerMessageRequest> {
  if (!isNonEmptyString(request.idempotency_key)) {
    throw new MockBackendApiError("idempotency_key is required", 400);
  }
  if (!isNonEmptyString(request.organization_id)) {
    throw new MockBackendApiError("organization_id is required", 400);
  }
  if (!isNonEmptyString(request.conversation_id)) {
    throw new MockBackendApiError("conversation_id is required", 400);
  }
  if (request.sender_type !== "manager") {
    throw new MockBackendApiError("sender_type must be manager", 400);
  }
  if (request.type !== "text") {
    throw new MockBackendApiError("type must be text", 400);
  }
  if (!isNonEmptyString(request.content?.text)) {
    throw new MockBackendApiError("content.text is required", 400);
  }
}

function validateAssistantSuggestRequest(request) {
  if (request.contract !== "C4.AssistantSuggestRequest" || request.version !== "1.0.0") {
    throw new MockBackendApiError("C4 assistant contract/version is invalid", 400);
  }
  for (const field of ["request_id", "organization_id", "query"]) {
    if (!isNonEmptyString(request[field])) {
      throw new MockBackendApiError(`${field} is required`, 400);
    }
  }
}

function createAiSuggestionText(query) {
  if (/резюме/i.test(query)) {
    return "Клиент уточняет статус заказа; ранее менеджер подтвердил проверку.";
  }
  if (/переведи/i.test(query)) {
    return "Customer asks to clarify the order status.";
  }
  if (/баз|kb|knowledge/i.test(query)) {
    return "По базе знаний: перед обещанием срока проверьте актуальный статус доставки.";
  }
  return "Поблагодарите клиента за ожидание, уточните номер заказа и сообщите, что статус доставки проверяется.";
}

function nextSequenceNumber(conversationId, messages) {
  return (
    messages.filter((message) => message.conversation_id === conversationId).reduce(
      (max, message) => Math.max(max, message.sequence_number),
      0,
    ) + 1
  );
}

function findById(items, id, label) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new MockBackendApiError(`${label} not found`, 404);
  }
  return item;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isSessionEnded(session, timestamp) {
  return Boolean(session.revoked_at) || Date.parse(session.expires_at) <= Date.parse(timestamp);
}

function addMs(isoTimestamp, ms) {
  return new Date(Date.parse(isoTimestamp) + ms).toISOString();
}

function normalizeUsername(username) {
  if (!isNonEmptyString(username)) {
    return null;
  }
  return username.replace(/^@/, "").trim().toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
