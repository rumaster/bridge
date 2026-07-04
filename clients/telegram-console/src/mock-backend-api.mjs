const DEFAULT_ORGANIZATION_ID = "org-1";
const DEFAULT_MANAGER_ID = "manager-1";
const DEFAULT_MANAGER_USERNAME = "manager_demo";

export function createMockTelegramConsoleBackendApi({
  now = () => new Date().toISOString(),
  aiAvailable = true,
} = {}) {
  const recordedRequests = [];
  const messagesByIdempotencyKey = new Map();
  const conversations = createConversations();
  const messages = createMessages();
  const notifications = createNotifications(now);

  const backend = {
    auth: {
      async startTelegramLogin(request = {}) {
        record("POST", "/auth/login/telegram/start", request);
        const telegramUsername = request.telegram_username ?? request.telegramUsername;
        if (!isNonEmptyString(telegramUsername)) {
          throw new MockBackendApiError("telegram username is required", 400);
        }

        return {
          request_id: "telegram-login-request-1",
          delivery: "telegram",
          expires_at: "2026-07-03T22:45:00.000Z",
          proxied_to: "C3.auth",
          upstream_operation: "POST /auth/login/telegram/start",
          mock: true,
        };
      },

      async verifyTelegramLogin(request = {}) {
        record("POST", "/auth/login/telegram/verify", request);
        if (!isNonEmptyString(request.request_id) || !isNonEmptyString(request.code)) {
          throw new MockBackendApiError("request_id and code are required", 400);
        }

        return createSession(now);
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
      async create(request = {}) {
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
      async suggest(request = {}) {
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

    getRecordedRequests() {
      return recordedRequests.map(clone);
    },

    getFixtures() {
      return clone({ conversations, clients: CLIENTS, messages, notifications });
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
  constructor(message, status) {
    super(message);
    this.name = "MockBackendApiError";
    this.status = status;
  }
}

function createSession(now) {
  return {
    contract: "TGC.ManagerSession",
    version: "1.0.0",
    token: "mock-manager-session",
    user: {
      id: DEFAULT_MANAGER_ID,
      display_name: "Демо Менеджер",
      role: "manager",
      telegram_username: DEFAULT_MANAGER_USERNAME,
    },
    organization: {
      id: DEFAULT_ORGANIZATION_ID,
      name: "Bridge Demo",
    },
    expires_at: "2026-07-04T00:00:00.000Z",
    created_at: now(),
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

function validateManagerMessageRequest(request) {
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
