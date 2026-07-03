import { createJsonApiClient } from "@bridge/api-client";
import type {
  WebChatAuthorType,
  WebChatMessage,
  WebChatMessageStatus,
  WebChatMessagesPage,
  WebChatSession,
} from "../types";

export const DEFAULT_API_BASE_URL = "/api/v1";
export const DEFAULT_ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
export const DEFAULT_CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";
export const DEFAULT_ENDPOINT_ID = "42345678-1234-4234-8234-123456789abc";

type Fetcher = typeof fetch;

export type CreateOrResumeSessionInput = {
  organizationId: string;
  visitorSessionId?: string | null;
  conversationId?: string;
};

export type SendMessageInput = {
  conversationId: string;
  endpointId: string;
  idempotencyKey: string;
  organizationId: string;
  text: string;
  visitorSessionId: string;
};

export type GetMessagesOptions = {
  afterSequenceNumber?: number;
  cursor?: string | null;
  limit?: number;
};

export type WebChatApiClient = {
  createOrResumeSession: (
    input: CreateOrResumeSessionInput,
  ) => Promise<WebChatSession>;
  getMessages: (
    conversationId: string,
    options?: GetMessagesOptions,
  ) => Promise<WebChatMessagesPage>;
  sendMessage: (input: SendMessageInput) => Promise<WebChatMessage>;
};

export type WebChatApiClientOptions = {
  baseUrl?: string;
  fetcher?: Fetcher;
};

export function createWebChatApiClient(
  options: WebChatApiClientOptions = {},
): WebChatApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_API_BASE_URL,
    fetcher: options.fetcher,
  });

  return {
    async createOrResumeSession(input) {
      return requestJson<WebChatSession>("/web-chat/sessions", {
        method: "POST",
        body: JSON.stringify(
          omitUndefined({
            channel: "web_chat",
            organization_id: input.organizationId,
            visitor_session_id: input.visitorSessionId ?? undefined,
            conversation_id: input.conversationId,
          }),
        ),
      });
    },

    async getMessages(conversationId, getMessagesOptions = {}) {
      const query = new URLSearchParams();
      if (typeof getMessagesOptions.limit === "number") {
        query.set("limit", String(getMessagesOptions.limit));
      }
      if (getMessagesOptions.cursor) {
        query.set("cursor", getMessagesOptions.cursor);
      }
      if (typeof getMessagesOptions.afterSequenceNumber === "number") {
        query.set("after_sequence_number", String(getMessagesOptions.afterSequenceNumber));
      }

      const response = await requestJson<unknown>(
        `/conversations/${encodeURIComponent(conversationId)}/messages${
          query.size > 0 ? `?${query.toString()}` : ""
        }`,
      );

      return normalizeMessagesPage(response);
    },

    async sendMessage(input) {
      const response = await requestJson<unknown>("/messages", {
        method: "POST",
        body: JSON.stringify({
          channel: "web_chat",
          conversation_id: input.conversationId,
          endpoint_id: input.endpointId,
          idempotency_key: input.idempotencyKey,
          organization_id: input.organizationId,
          visitor_session_id: input.visitorSessionId,
          body: {
            type: "text",
            text: input.text,
          },
        }),
        headers: {
          "idempotency-key": input.idempotencyKey,
        },
      });

      return normalizeMessage(response);
    },
  };
}

export function normalizeMessagesPage(value: unknown): WebChatMessagesPage {
  const record = isRecord(value) ? value : null;
  const rawMessages = Array.isArray(value)
    ? value
    : Array.isArray(record?.messages)
      ? record.messages
      : Array.isArray(record?.items)
        ? record.items
        : Array.isArray(record?.data)
          ? record.data
          : [];
  const page = isRecord(record?.page)
    ? record.page
    : isRecord(record?.pagination)
      ? record.pagination
      : null;
  const nextCursor =
    typeof record?.nextCursor === "string"
      ? record.nextCursor
      : typeof page?.nextCursor === "string"
        ? page.nextCursor
        : typeof page?.next_cursor === "string"
          ? page.next_cursor
          : null;

  return {
    messages: rawMessages.map(normalizeMessage),
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

export function normalizeMessage(value: unknown): WebChatMessage {
  if (!isRecord(value)) {
    throw new TypeError("message must be an object");
  }

  const author = isRecord(value.author) ? value.author : null;
  const body = isRecord(value.body) ? value.body : null;
  const content = isRecord(value.content) ? value.content : null;
  const senderType = getString(value.senderType) ?? getString(value.sender_type);
  const direction = getString(value.direction);
  const authorType = normalizeAuthorType(
    getString(author?.type) ?? senderType,
    direction,
  );
  const text =
    getString(body?.text) ??
    getString(content?.text) ??
    getString(value.text) ??
    "";
  const sequenceNumber =
    getNumber(value.sequenceNumber) ?? getNumber(value.sequence_number) ?? undefined;

  return {
    id: requireString(value.id, "message.id"),
    idempotencyKey: getString(value.idempotencyKey) ?? getString(value.idempotency_key),
    organizationId:
      requireString(value.organizationId ?? value.organization_id, "message.organizationId"),
    conversationId:
      requireString(value.conversationId ?? value.conversation_id, "message.conversationId"),
    endpointId: getString(value.endpointId) ?? getString(value.endpoint_id),
    channel: "web_chat",
    author: {
      type: authorType,
      displayName:
        getString(author?.displayName) ??
        getString(author?.display_name) ??
        defaultDisplayName(authorType),
    },
    body: {
      type: "text",
      text,
    },
    createdAt: requireString(value.createdAt ?? value.created_at, "message.createdAt"),
    ...(sequenceNumber === undefined ? {} : { sequenceNumber }),
    status: normalizeStatus(getString(value.status)),
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function normalizeAuthorType(
  value: string | undefined,
  direction: string | undefined,
): WebChatAuthorType {
  if (value === "visitor") {
    return "visitor";
  }

  if (value === "client") {
    return "visitor";
  }

  if (value === "manager" || value === "ai" || value === "system") {
    return value;
  }

  if (direction === "inbound") {
    return "visitor";
  }

  if (direction === "outbound") {
    return "manager";
  }

  return "system";
}

function normalizeStatus(value: string | undefined): WebChatMessageStatus | undefined {
  switch (value) {
    case "received":
    case "routed":
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function defaultDisplayName(authorType: WebChatAuthorType): string {
  switch (authorType) {
    case "visitor":
      return "Посетитель";
    case "manager":
      return "Менеджер";
    case "ai":
      return "Bridge AI";
    case "system":
      return "Система";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  return value;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
