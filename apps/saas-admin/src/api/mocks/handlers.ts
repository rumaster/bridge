import { HttpResponse, http } from "msw";

import { mockConfiguration, mockOrganization, mockSession } from "./fixtures";

const API_PREFIX = "*/api/v1";

export const handlers = [
  http.get(`${API_PREFIX}/auth/session`, () => HttpResponse.json(mockSession)),

  http.post(`${API_PREFIX}/auth/login/telegram/start`, async ({ request }) => {
    const body = (await request.json()) as { telegramUsername?: string };

    if (!body.telegramUsername) {
      return HttpResponse.json({ message: "telegramUsername is required" }, { status: 400 });
    }

    return HttpResponse.json({
      requestId: "admin-login-request-1",
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

  http.get(`${API_PREFIX}/organizations/:organizationId`, ({ params }) => {
    if (params.organizationId !== mockOrganization.id) {
      return HttpResponse.json({ message: "Organization not found" }, { status: 404 });
    }

    return HttpResponse.json(mockOrganization);
  }),

  http.get(`${API_PREFIX}/organizations/:organizationId/configuration`, ({ params }) => {
    if (params.organizationId !== mockConfiguration.organizationId) {
      return HttpResponse.json({ message: "Organization configuration not found" }, { status: 404 });
    }

    return HttpResponse.json(mockConfiguration);
  })
];
