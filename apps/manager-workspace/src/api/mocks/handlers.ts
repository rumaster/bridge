import { HttpResponse, http, ws } from "msw";

import type { SendMessageRequest } from "../client/types";
import {
  mockC7Events,
  mockClients,
  mockConversations,
  mockMessages,
  mockNotifications,
  mockSession
} from "./fixtures";

const API_PREFIX = "*/api/v1";
const c7Socket = ws.link("ws://localhost/api/v1/ws");

export const handlers = [
  http.get(`${API_PREFIX}/auth/session`, () => HttpResponse.json(mockSession)),

  http.post(`${API_PREFIX}/auth/login/telegram/start`, async ({ request }) => {
    const body = (await request.json()) as { telegramUsername?: string };

    if (!body.telegramUsername) {
      return HttpResponse.json({ message: "telegramUsername is required" }, { status: 400 });
    }

    return HttpResponse.json({
      requestId: "telegram-login-request-1",
      delivery: "telegram",
      expiresAt: "2026-07-02T16:20:00.000Z"
    });
  }),

  http.post(`${API_PREFIX}/auth/login/telegram/verify`, async ({ request }) => {
    const body = (await request.json()) as { requestId?: string; code?: string };

    if (!body.requestId || !body.code) {
      return HttpResponse.json({ message: "requestId and code are required" }, { status: 400 });
    }

    return HttpResponse.json(mockSession);
  }),

  http.post(`${API_PREFIX}/auth/logout`, () => new HttpResponse(null, { status: 204 })),

  http.get(`${API_PREFIX}/conversations`, () => HttpResponse.json(mockConversations)),

  http.get(`${API_PREFIX}/conversations/:conversationId`, ({ params }) => {
    const conversation = mockConversations.find((item) => item.id === params.conversationId);

    if (!conversation) {
      return HttpResponse.json({ message: "Conversation not found" }, { status: 404 });
    }

    return HttpResponse.json(conversation);
  }),

  http.get(`${API_PREFIX}/conversations/:conversationId/messages`, ({ params }) => {
    return HttpResponse.json(
      mockMessages.filter((message) => message.conversationId === params.conversationId)
    );
  }),

  http.post(`${API_PREFIX}/messages`, async ({ request }) => {
    const body = (await request.json()) as SendMessageRequest;
    const message = {
      id: `msg-${body.idempotencyKey}`,
      conversationId: body.conversationId,
      channel: "web_chat",
      direction: "outbound",
      senderType: "manager",
      content: body.content,
      status: "sent",
      createdAt: "2026-07-02T16:12:00.000Z"
    };

    return HttpResponse.json(message, { status: 201 });
  }),

  http.get(`${API_PREFIX}/messages/:messageId`, ({ params }) => {
    const message = mockMessages.find((item) => item.id === params.messageId);

    if (!message) {
      return HttpResponse.json({ message: "Message not found" }, { status: 404 });
    }

    return HttpResponse.json(message);
  }),

  http.get(`${API_PREFIX}/clients`, () => HttpResponse.json(mockClients)),

  http.get(`${API_PREFIX}/clients/:clientId`, ({ params }) => {
    const client = mockClients.find((item) => item.id === params.clientId);

    if (!client) {
      return HttpResponse.json({ message: "Client not found" }, { status: 404 });
    }

    return HttpResponse.json(client);
  }),

  http.get(`${API_PREFIX}/notifications`, () => HttpResponse.json(mockNotifications)),

  http.post(/\/api\/v1\/notifications\/([^/]+):read$/, ({ request }) => {
    const notificationId = new URL(request.url).pathname.match(/\/notifications\/([^/]+):read$/)?.[1];
    const notification = mockNotifications.find((item) => item.id === notificationId);

    if (!notification) {
      return HttpResponse.json({ message: "Notification not found" }, { status: 404 });
    }

    return HttpResponse.json({ ...notification, status: "read" });
  }),

  c7Socket.addEventListener("connection", ({ client }) => {
    for (const event of mockC7Events) {
      client.send(JSON.stringify(event));
    }
  })
];
