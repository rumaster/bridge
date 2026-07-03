import { http, HttpResponse, ws } from "msw";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ENDPOINT_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../platform/apiClient";
import type { WebChatMessage, WebChatRealtimeEvent, WebChatSession } from "../types";

const chatEvents = ws.link("*/api/v1/ws");
const mockMessages: WebChatMessage[] = [];
const mockSessions = new Map<string, WebChatSession>();

export function resetMockMessages(messages: WebChatMessage[] = []) {
  mockMessages.splice(0, mockMessages.length, ...messages);
  mockSessions.clear();
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

  http.get("*/api/v1/conversations/:conversationId/messages", ({ params }) => {
    const conversationId = String(params.conversationId);

    return HttpResponse.json(
      mockMessages.filter(
        (message) => message.conversationId === conversationId,
      ),
    );
  }),

  http.post("*/api/v1/messages", async ({ request }) => {
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
      mockMessages.push(message, createManagerReply(message));
    }
    chatEvents.broadcast(
      JSON.stringify({
        type: "message.created",
        payload: existingMessage ?? message,
      } satisfies WebChatRealtimeEvent),
    );

    return HttpResponse.json(existingMessage ?? message, {
      status: existingMessage ? 200 : 201,
    });
  }),

  chatEvents.addEventListener("connection", ({ client }) => {
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
    status: "delivered",
  };
}

function createManagerReply(sourceMessage: WebChatMessage): WebChatMessage {
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
    status: "sent",
  };
}
