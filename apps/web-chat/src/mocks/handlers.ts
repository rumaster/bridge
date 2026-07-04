import { http, HttpResponse, ws } from "msw";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ENDPOINT_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../platform/apiClient";
import type {
  C7WebSocketEvent,
  WebChatMessage,
  WebChatRealtimeEvent,
  WebChatSession,
} from "../types";

const chatEvents = ws.link("*/api/v1/ws");
const mockMessages: WebChatMessage[] = [];
const mockSessions = new Map<string, WebChatSession>();
let mockEventSequenceNumber = 0;
// Флаг эмуляции разрыва канала до Edge (CP-7): при true REST-отправка падает, а
// WS-подключения немедленно закрываются — так e2e воспроизводит «Потерю
// соединения» из ТЗ §5.5 без изменения контрактов.
let edgeOutage = false;

export function resetMockMessages(messages: WebChatMessage[] = []) {
  mockMessages.splice(
    0,
    mockMessages.length,
    ...messages
      .map((message, index) => ({
        ...message,
        sequenceNumber: message.sequenceNumber ?? index + 1,
      }))
      .sort(compareMessages),
  );
  mockSessions.clear();
  mockEventSequenceNumber = 0;
  edgeOutage = false;
}

/**
 * Управление эмуляцией разрыва Edge для e2e-сценария CP-7 «Потеря соединения».
 * При включении обрывает активные WS-подключения; при выключении виджет
 * переподключается и автоматически переотправляет буфер исходящих.
 */
export function setWebChatEdgeOutage(value: boolean) {
  edgeOutage = value;
  if (value) {
    for (const client of chatEvents.clients) {
      client.close(1012, "edge-outage");
    }
  }
}

export const webChatMockHandlers = [
  http.post("*/api/v1/web-chat/sessions", async ({ request }) => {
    const payload = (await request.json()) as {
      conversation_id?: string;
      organization_id?: string;
      visitor_session_id?: string;
    };
    const organizationId = payload.organization_id ?? DEFAULT_ORGANIZATION_ID;
    const visitorSessionId =
      payload.visitor_session_id?.trim() || `web-chat-visitor-${crypto.randomUUID()}`;
    const existingSession = mockSessions.get(visitorSessionId);

    if (existingSession) {
      return HttpResponse.json(existingSession);
    }

    const session = {
      visitorSessionId,
      organizationId,
      conversationId: payload.conversation_id ?? DEFAULT_CONVERSATION_ID,
      endpointId: DEFAULT_ENDPOINT_ID,
    } satisfies WebChatSession;

    mockSessions.set(visitorSessionId, session);
    return HttpResponse.json(session, { status: 201 });
  }),

  http.get("*/api/v1/conversations/:conversationId/messages", ({ params, request }) => {
    const conversationId = String(params.conversationId);
    const url = new URL(request.url);
    const page = paginateMessages(
      mockMessages.filter(
        (message) => message.conversationId === conversationId,
      ),
      {
        afterSequenceNumber: Number(url.searchParams.get("after_sequence_number")) || null,
        cursor: url.searchParams.get("cursor"),
        limit: Number(url.searchParams.get("limit")) || 20,
      },
    );

    return HttpResponse.json({
      items: page.messages,
      page: {
        limit: page.limit,
        nextCursor: page.nextCursor,
        total: page.total,
      },
    });
  }),

  http.post("*/api/v1/messages", async ({ request }) => {
    if (edgeOutage) {
      // Канал до Edge оборван: отправка не доходит, реплика остаётся в буфере.
      return HttpResponse.error();
    }

    const payload = (await request.json()) as {
      conversation_id?: string;
      organization_id?: string;
      endpoint_id?: string;
      idempotency_key?: string;
      visitor_session_id?: string;
      body?: {
        text?: string;
      };
    };
    const message = createMockMessage({
      conversationId: payload.conversation_id ?? DEFAULT_CONVERSATION_ID,
      endpointId: payload.endpoint_id ?? DEFAULT_ENDPOINT_ID,
      idempotencyKey: payload.idempotency_key ?? crypto.randomUUID(),
      organizationId: payload.organization_id ?? DEFAULT_ORGANIZATION_ID,
      text: payload.body?.text ?? "",
    });

    const existingMessage = mockMessages.find((item) => item.id === message.id);
    if (!existingMessage) {
      const managerReply = createManagerReply(message);
      mockMessages.push(message, managerReply);
      mockMessages.sort(compareMessages);
      broadcastMessageCreated(message);
      broadcastMessageCreated(managerReply);
    } else {
      broadcastMessageCreated(existingMessage);
    }

    return HttpResponse.json(existingMessage ?? message, {
      status: existingMessage ? 200 : 201,
    });
  }),

  chatEvents.addEventListener("connection", ({ client }) => {
    if (edgeOutage) {
      // Пока длится разрыв — не даём подключению закрепиться.
      client.close(1012, "edge-outage");
      return;
    }

    client.send(
      JSON.stringify({
        type: "mock.connected",
        contract: "C7",
        channel: "web_chat",
      } satisfies WebChatRealtimeEvent),
    );
  }),
];

function createMockMessage({
  conversationId,
  endpointId,
  idempotencyKey,
  organizationId,
  text,
}: {
  conversationId: string;
  endpointId: string;
  idempotencyKey: string;
  organizationId: string;
  text: string;
}): WebChatMessage {
  return {
    id: idempotencyKey,
    idempotencyKey,
    conversationId,
    endpointId,
    organizationId,
    channel: "web_chat",
    author: {
      type: "visitor",
      displayName: "Посетитель",
    },
    body: {
      type: "text",
      text,
    },
    createdAt: new Date().toISOString(),
    sequenceNumber: nextSequenceNumber(conversationId),
    status: "delivered",
  };
}

function createManagerReply(sourceMessage: WebChatMessage): WebChatMessage {
  const sequenceNumber = Math.max(
    nextSequenceNumber(sourceMessage.conversationId),
    (sourceMessage.sequenceNumber ?? 0) + 1,
  );

  return {
    id: crypto.randomUUID(),
    conversationId: sourceMessage.conversationId,
    endpointId: sourceMessage.endpointId,
    organizationId: sourceMessage.organizationId,
    channel: "web_chat",
    author: {
      type: "manager",
      displayName: "Менеджер",
    },
    body: {
      type: "text",
      text: "Здравствуйте! Менеджер получил сообщение.",
    },
    createdAt: new Date().toISOString(),
    sequenceNumber,
    status: "sent",
  };
}

function paginateMessages(
  messages: WebChatMessage[],
  {
    afterSequenceNumber,
    cursor,
    limit,
  }: {
    afterSequenceNumber: null | number;
    cursor: null | string;
    limit: number;
  },
) {
  const normalizedLimit = Math.max(1, Math.min(100, limit));
  const sortedMessages = [...messages].sort(compareMessages);

  if (afterSequenceNumber !== null) {
    const pageMessages = sortedMessages
      .filter((message) => (message.sequenceNumber ?? 0) > afterSequenceNumber)
      .slice(0, normalizedLimit);

    return {
      messages: pageMessages,
      nextCursor: null,
      limit: normalizedLimit,
      total: sortedMessages.length,
    };
  }

  const beforeSequenceNumber = parseBeforeCursor(cursor);
  const eligibleMessages =
    beforeSequenceNumber === null
      ? sortedMessages
      : sortedMessages.filter(
          (message) => (message.sequenceNumber ?? 0) < beforeSequenceNumber,
        );
  const pageMessages = eligibleMessages.slice(-normalizedLimit);
  const firstSequenceNumber = pageMessages[0]?.sequenceNumber ?? null;
  const hasMore =
    firstSequenceNumber !== null &&
    eligibleMessages.some(
      (message) => (message.sequenceNumber ?? 0) < firstSequenceNumber,
    );

  return {
    messages: pageMessages,
    nextCursor: hasMore ? `before:${firstSequenceNumber}` : null,
    limit: normalizedLimit,
    total: sortedMessages.length,
  };
}

function parseBeforeCursor(cursor: null | string): null | number {
  if (!cursor?.startsWith("before:")) {
    return null;
  }

  const sequenceNumber = Number(cursor.slice("before:".length));
  return Number.isFinite(sequenceNumber) ? sequenceNumber : null;
}

function nextSequenceNumber(conversationId: string): number {
  return (
    mockMessages
      .filter((message) => message.conversationId === conversationId)
      .reduce(
        (maxSequenceNumber, message) =>
          Math.max(maxSequenceNumber, message.sequenceNumber ?? 0),
        0,
      ) + 1
  );
}

function broadcastMessageCreated(message: WebChatMessage) {
  chatEvents.broadcast(
    JSON.stringify(
      createC7Event("message.created", {
        message,
      }, message.sequenceNumber ?? nextEventSequenceNumber(), message.organizationId),
    ),
  );
}

function createC7Event(
  event: C7WebSocketEvent["event"],
  payload: Record<string, unknown>,
  sequenceNumber = nextEventSequenceNumber(),
  organizationId = DEFAULT_ORGANIZATION_ID,
): C7WebSocketEvent {
  return {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event,
    event_id: `mock-event-${nextEventSequenceNumber()}`,
    organization_id: organizationId,
    sequence_number: sequenceNumber,
    payload,
    occurred_at: new Date().toISOString(),
  };
}

function nextEventSequenceNumber(): number {
  mockEventSequenceNumber += 1;
  return mockEventSequenceNumber;
}

function compareMessages(left: WebChatMessage, right: WebChatMessage): number {
  const sequenceDifference = (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0);
  if (sequenceDifference !== 0) {
    return sequenceDifference;
  }

  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}
