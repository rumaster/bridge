import { http, HttpResponse, ws } from "msw";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../platform/apiClient";
import type { WebChatMessage, WebChatRealtimeEvent } from "../types";

const chatEvents = ws.link("*/api/v1/ws");
const mockMessages: WebChatMessage[] = [];

export function resetMockMessages(messages: WebChatMessage[] = []) {
  mockMessages.splice(0, mockMessages.length, ...messages);
}

export const webChatMockHandlers = [
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
      body?: {
        text?: string;
      };
    };
    const message = createMockMessage({
      conversationId: payload.conversation_id ?? DEFAULT_CONVERSATION_ID,
      organizationId: payload.organization_id ?? DEFAULT_ORGANIZATION_ID,
      text: payload.body?.text ?? "",
    });

    mockMessages.push(message);
    chatEvents.broadcast(
      JSON.stringify({
        type: "message.created",
        payload: message,
      } satisfies WebChatRealtimeEvent),
    );

    return HttpResponse.json(message, { status: 201 });
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
  organizationId,
  text,
}: {
  conversationId: string;
  organizationId: string;
  text: string;
}): WebChatMessage {
  return {
    id: `web-chat-message-${crypto.randomUUID()}`,
    conversationId,
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
    status: "sent",
  };
}
