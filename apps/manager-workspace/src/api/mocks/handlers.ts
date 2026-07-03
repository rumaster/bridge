import { HttpResponse, http, ws } from "msw";

import type { AssistantSuggestRequest, SendMessageRequest } from "../client/types";
import { MockBackendError, createMockManagerWorkspaceBackend } from "./backend";
import { mockC7Events } from "./fixtures";

const API_PREFIX = "*/api/v1";
const c7Socket = ws.link("*/api/v1/ws");

type JsonResponseBody = Record<string, any> | string | number | boolean | null | undefined;

let backend = createMockManagerWorkspaceBackend();

export function resetMockManagerWorkspaceBackend() {
  backend = createMockManagerWorkspaceBackend();
}

export const handlers = [
  http.get(`${API_PREFIX}/auth/session`, () => toJsonResponse(() => backend.getSession())),

  http.post(`${API_PREFIX}/auth/login/telegram/start`, async ({ request }) => {
    const body = (await request.json()) as { telegramUsername?: string };
    return toJsonResponse(() => backend.startTelegramLogin({ telegramUsername: body.telegramUsername ?? "" }));
  }),

  http.post(`${API_PREFIX}/auth/login/telegram/verify`, async ({ request }) => {
    const body = (await request.json()) as { requestId?: string; code?: string };
    return toJsonResponse(() =>
      backend.verifyTelegramLogin({
        requestId: body.requestId ?? "",
        code: body.code ?? ""
      })
    );
  }),

  http.post(`${API_PREFIX}/auth/logout`, () => {
    backend.logout();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API_PREFIX}/conversations`, () => toJsonResponse(() => backend.listConversations())),

  http.get(`${API_PREFIX}/conversations/:conversationId`, ({ params }) => {
    return toJsonResponse(() => backend.getConversation(String(params.conversationId)));
  }),

  http.get(`${API_PREFIX}/conversations/:conversationId/messages`, ({ params }) => {
    return toJsonResponse(() => backend.listMessages(String(params.conversationId)));
  }),

  http.post(`${API_PREFIX}/messages`, async ({ request }) => {
    const body = (await request.json()) as SendMessageRequest;
    return toJsonResponse(() => backend.createMessage(body), 201);
  }),

  http.get(`${API_PREFIX}/messages/:messageId`, ({ params }) => {
    return toJsonResponse(() => backend.getMessage(String(params.messageId)));
  }),

  http.get(`${API_PREFIX}/clients`, () => toJsonResponse(() => backend.listClients())),

  http.get(`${API_PREFIX}/clients/:clientId`, ({ params }) => {
    return toJsonResponse(() => backend.getClient(String(params.clientId)));
  }),

  http.get(`${API_PREFIX}/notifications`, () => toJsonResponse(() => backend.listNotifications())),

  http.post(/\/api\/v1\/notifications\/([^/]+):read$/, ({ request }) => {
    const notificationId = new URL(request.url).pathname.match(/\/notifications\/([^/]+):read$/)?.[1];
    return toJsonResponse(() => backend.markNotificationRead(notificationId ?? ""));
  }),

  http.post(`${API_PREFIX}/ai/assistant:suggest`, async ({ request }) => {
    const body = (await request.json()) as AssistantSuggestRequest;
    return toJsonResponse(() => backend.suggestAssistant(body));
  }),

  c7Socket.addEventListener("connection", ({ client }) => {
    for (const event of mockC7Events) {
      client.send(JSON.stringify(event));
    }
  })
];

function toJsonResponse<T extends JsonResponseBody>(operation: () => T, successStatus = 200) {
  try {
    return HttpResponse.json(operation(), { status: successStatus });
  } catch (error) {
    if (error instanceof MockBackendError) {
      return HttpResponse.json({ message: error.message }, { status: error.status });
    }

    throw error;
  }
}
