import { BridgeApiError, createJsonApiClient } from "@bridge/api-client";
import type {
  AssistantSuggestRequest,
  AssistantSuggestResponse,
  Channel,
  ClientProfile,
  ClientPresenceStatus,
  CommunicationEndpoint,
  Conversation,
  ConversationStatus,
  ManagerSession,
  ManagerWorkspaceApiClient,
  Message,
  MessageAttachment,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  NotificationCategory,
  NotificationItem,
  NotificationStatus,
  SendMessageRequest,
  TelegramLoginStartRequest,
  TelegramLoginStartResponse,
  TelegramLoginVerifyRequest,
  UploadedAttachment
} from "./types";
import { MANAGER_WORKSPACE_SESSION_STORAGE_KEY } from "../../state/session-storage";

export interface ManagerWorkspaceApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "/api/v1";
const TENANT_HEADER = "x-organization-id";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = ["web_chat", "telegram", "email"] as const satisfies readonly Channel[];
const CLIENT_PRESENCE_STATUSES = ["online", "offline"] as const satisfies readonly ClientPresenceStatus[];
const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const satisfies readonly ConversationStatus[];
const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const satisfies readonly MessageDirection[];
const MESSAGE_SENDER_TYPES = ["client", "manager", "system"] as const satisfies readonly MessageSenderType[];
const MESSAGE_STATUSES = ["received", "routed", "sent", "delivered", "failed"] as const satisfies readonly MessageStatus[];
const NOTIFICATION_CATEGORIES = ["info", "warning", "error", "critical", "admin"] as const satisfies readonly NotificationCategory[];
const NOTIFICATION_STATUSES = ["new", "read"] as const satisfies readonly NotificationStatus[];

export function createManagerWorkspaceApiClient(
  options: ManagerWorkspaceApiClientOptions = {}
): ManagerWorkspaceApiClient {
  const jsonClient = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    defaultHeaders: readTenantHeaders,
    fetcher: options.fetcher
  });
  const { requestJson } = jsonClient;
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

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
      list: async () =>
        extractItems(await requestJson<ConversationApiListResponse>("/conversations")).map(normalizeConversation),
      get: async (conversationId: string) =>
        normalizeConversation(await requestJson<ConversationApiResponse>(`/conversations/${conversationId}`)),
      listMessages: (conversationId: string) =>
        requestJson<MessageApiListResponse>(`/conversations/${conversationId}/messages`).then((response) =>
          extractItems(response).map(normalizeMessage)
        )
    },
    messages: {
      create: (request: SendMessageRequest) =>
        requestJson<MessageApiResponse>("/messages", {
          method: "POST",
          body: JSON.stringify(toCreateMessageBody(request))
        }).then(normalizeMessage),
      get: (messageId: string) => requestJson<MessageApiResponse>(`/messages/${messageId}`).then(normalizeMessage)
    },
    attachments: {
      // Скачиваем через API-клиент (а не плоским <a href>): fetch несёт
      // tenant-заголовок и same-origin cookie сессии — без них backend-прокси
      // (`/attachments/:id/content`) ответил бы 400/401.
      download: async (attachmentId: string): Promise<Blob> => {
        const url = jsonClient.resolveUrl(`/attachments/${attachmentId}/content`);
        const response = await fetcher(url, { headers: readTenantHeaders() });
        if (!response.ok) {
          throw new BridgeApiError(`Attachment download failed with ${response.status}`, {
            status: response.status,
            body: undefined,
            url
          });
        }
        return response.blob();
      },
      // Загрузка файла к ответу менеджера: сырые байты POST-ом на backend, который
      // проксирует их на RF-том Edge. Имя файла — в заголовке (URL-encoded для
      // кириллицы), MIME — content-type. Возвращает дескриптор с непрозрачным
      // storageRef для последующего POST /messages.
      upload: async (file: File): Promise<UploadedAttachment> => {
        const url = jsonClient.resolveUrl("/attachments");
        const response = await fetcher(url, {
          method: "POST",
          headers: {
            ...readTenantHeaders(),
            "content-type": file.type && file.type !== "" ? file.type : "application/octet-stream",
            "x-attachment-filename": encodeURIComponent(file.name)
          },
          body: file
        });
        if (!response.ok) {
          throw new BridgeApiError(`Attachment upload failed with ${response.status}`, {
            status: response.status,
            body: undefined,
            url
          });
        }
        return (await response.json()) as UploadedAttachment;
      }
    },
    clients: {
      list: async () =>
        extractItems(await requestJson<ClientApiListResponse>("/clients")).map(normalizeClient),
      get: (clientId: string) => requestJson<ClientApiResponse>(`/clients/${clientId}`).then(normalizeClient)
    },
    notifications: {
      list: async () =>
        extractItems(await requestJson<NotificationApiListResponse>("/notifications")).map(normalizeNotification),
      markRead: (notificationId: string) =>
        requestJson<NotificationReadApiResponse>(`/notifications/${notificationId}:read`, {
          method: "POST"
        }).then(normalizeNotificationReadResponse)
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

type PaginatedApiResponse<TItem> = {
  items: TItem[];
  page?: unknown;
};

type ConversationApiResponse = Partial<Conversation> & {
  createdAt?: string;
  lastMessageAt?: string | null;
  updatedAt?: string;
};
type ConversationApiListResponse = ConversationApiResponse[] | PaginatedApiResponse<ConversationApiResponse>;

type MessageApiResponse = Omit<Partial<Message>, "attachments" | "content"> & {
  attachments?: unknown;
  content?: Record<string, unknown> | string;
};
type MessageApiListResponse = MessageApiResponse[] | PaginatedApiResponse<MessageApiResponse>;

type ClientApiResponse = Omit<Partial<ClientProfile>, "endpoints" | "notes" | "tags"> & {
  endpoints?: unknown;
  notes?: unknown;
  tags?: unknown;
};
type ClientApiListResponse = ClientApiResponse[] | PaginatedApiResponse<ClientApiResponse>;

type NotificationApiResponse = Partial<NotificationItem> & {
  created_at?: string;
};
type NotificationApiListResponse = NotificationApiResponse[] | PaginatedApiResponse<NotificationApiResponse>;
type NotificationReadApiResponse = NotificationApiResponse | { notification: NotificationApiResponse };

/**
 * Тело POST /messages. Тему email кладём в content как объект `{text, subject}`
 * (ядро принимает content объектом; egress читает `content.subject`, Этап E4),
 * поэтому не-email отправки остаются `content: string` без изменения поведения.
 */
function toCreateMessageBody(request: SendMessageRequest): {
  conversationId: string;
  idempotencyKey: string;
  content: string | { text: string; subject: string };
  attachments?: Array<{ storageRef: string; name: string; contentType?: string; sizeBytes?: number }>;
} {
  const subject = request.subject?.trim();
  const attachments = (request.attachments ?? [])
    .filter((attachment) => attachment.storageRef.trim() !== "")
    .map((attachment) => ({
      storageRef: attachment.storageRef,
      name: attachment.name,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(Number.isFinite(attachment.sizeBytes) ? { sizeBytes: attachment.sizeBytes } : {})
    }));

  return {
    conversationId: request.conversationId,
    idempotencyKey: request.idempotencyKey,
    content: subject ? { text: request.content, subject } : request.content,
    ...(attachments.length > 0 ? { attachments } : {})
  };
}

function readTenantHeaders(): HeadersInit {
  const organizationId = readStoredOrganizationId();

  return organizationId ? { [TENANT_HEADER]: organizationId } : {};
}

/**
 * Читает organization_id арендатора из сохранённой сессии менеджера
 * (localStorage). Используется и как tenant-заголовок REST-запросов, и как
 * scope C7-realtime подписки (organization_id в WS-URL): WS-сервер App-стороны
 * фильтрует события по organization_id, поэтому без него менеджер не получит ни
 * одного realtime-события. Возвращает undefined, если сессии нет или org не
 * прошёл валидацию UUID v4.
 */
export function readStoredOrganizationId() {
  if (typeof window === "undefined") {
    return undefined;
  }

  const storedSession = window.localStorage.getItem(MANAGER_WORKSPACE_SESSION_STORAGE_KEY);
  if (!storedSession) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storedSession) as Partial<ManagerSession>;
    const organizationId = parsed.organization?.id;

    return organizationId && UUID_V4_PATTERN.test(organizationId) ? organizationId : undefined;
  } catch {
    return undefined;
  }
}

function extractItems<TItem>(response: TItem[] | PaginatedApiResponse<TItem>): TItem[] {
  return Array.isArray(response) ? response : response.items;
}

function normalizeConversation(conversation: ConversationApiResponse): Conversation {
  const lastMessageAt =
    conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt ?? new Date(0).toISOString();

  return {
    channel: pickOne(conversation.channel, CHANNELS, "web_chat"),
    clientId: stringValue(conversation.clientId),
    id: stringValue(conversation.id),
    lastMessageAt,
    lastMessagePreview: stringValue(conversation.lastMessagePreview),
    status: pickOne(conversation.status, CONVERSATION_STATUSES, "open"),
    unreadCount: numberValue(conversation.unreadCount)
  };
}

function normalizeMessage(message: MessageApiResponse): Message {
  return {
    attachments: normalizeAttachments(message.attachments),
    channel: pickOne(message.channel, CHANNELS, "web_chat"),
    content: normalizeMessageContent(message.content),
    conversationId: stringValue(message.conversationId),
    createdAt: stringValue(message.createdAt, new Date(0).toISOString()),
    direction: pickOne(message.direction, MESSAGE_DIRECTIONS, "inbound"),
    id: stringValue(message.id),
    senderType: pickOne(message.senderType, MESSAGE_SENDER_TYPES, "system"),
    status: pickOne(message.status, MESSAGE_STATUSES, "received")
  };
}

function normalizeClient(client: ClientApiResponse): ClientProfile {
  return {
    displayName: stringValue(client.displayName, "Клиент без имени"),
    endpoints: arrayValue(client.endpoints).map(normalizeEndpoint).filter(isPresent),
    id: stringValue(client.id),
    notes: arrayValue(client.notes).map((note) => stringValue(note)).filter(Boolean),
    status: pickOptional(client.status, CLIENT_PRESENCE_STATUSES),
    tags: arrayValue(client.tags).map((tag) => stringValue(tag)).filter(Boolean)
  };
}

function normalizeNotification(notification: NotificationApiResponse): NotificationItem {
  return {
    body: stringValue(notification.body),
    category: pickOne(notification.category, NOTIFICATION_CATEGORIES, "info"),
    createdAt: stringValue(notification.createdAt ?? notification.created_at, new Date(0).toISOString()),
    id: stringValue(notification.id),
    status: pickOne(notification.status, NOTIFICATION_STATUSES, "new"),
    title: stringValue(notification.title)
  };
}

function normalizeNotificationReadResponse(response: NotificationReadApiResponse): NotificationItem {
  return normalizeNotification("notification" in response ? response.notification : response);
}

function normalizeEndpoint(endpoint: unknown): CommunicationEndpoint | null {
  if (!isRecord(endpoint)) {
    return null;
  }

  const externalId = stringValue(endpoint.externalId ?? endpoint.external_id);

  return {
    channel: pickOne(endpoint.channel, CHANNELS, "web_chat"),
    displayName: stringValue(endpoint.displayName ?? endpoint.display_name, externalId),
    externalId,
    id: stringValue(endpoint.id)
  };
}

function normalizeAttachments(value: unknown): MessageAttachment[] | undefined {
  const attachments = arrayValue(value).map(normalizeAttachment).filter(isPresent);

  return attachments.length > 0 ? attachments : undefined;
}

function normalizeAttachment(attachment: unknown): MessageAttachment | null {
  if (!isRecord(attachment)) {
    return null;
  }

  return {
    contentType: stringValue(attachment.contentType ?? attachment.content_type),
    id: stringValue(attachment.id),
    name: stringValue(attachment.name),
    sizeBytes: numberValue(attachment.sizeBytes ?? attachment.size_bytes),
    url: stringValue(attachment.url)
  };
}

function normalizeMessageContent(content: Record<string, unknown> | string | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!content) {
    return "";
  }

  const text = content.text ?? content.body;
  if (typeof text === "string") {
    return text;
  }

  return JSON.stringify(content);
}

function pickOne<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  fallback: TValue
): TValue {
  return pickOptional(value, allowedValues) ?? fallback;
}

function pickOptional<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[]
): TValue | undefined {
  return typeof value === "string" && (allowedValues as readonly string[]).includes(value)
    ? (value as TValue)
    : undefined;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
