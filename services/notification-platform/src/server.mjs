import { createServer } from "node:http";

import { C10DtoValidationError } from "./c10-dto.mjs";
import {
  C10NotificationNotFoundError,
  createDeterministicNotificationMock,
} from "./deterministic-notification.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

export function createNotificationPlatformServer({
  notifications,
  now = () => new Date().toISOString(),
} = {}) {
  const mockNotifications =
    notifications ?? createDeterministicNotificationMock({ now });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://notification-platform.local");
      const path = normalizeApiPath(url.pathname);
      const context = requestContext(request);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "notification-platform",
          mode: "deterministic-mock",
          contract: "C10",
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderMetrics(mockNotifications.getMetrics()));
        return;
      }

      if (request.method === "GET" && path === "/notifications") {
        sendJson(
          response,
          200,
          mockNotifications.listNotifications(context, queryObject(url.searchParams)),
        );
        return;
      }

      const readMatch = path.match(/^\/notifications\/([^/]+):read$/);
      if (request.method === "POST" && readMatch) {
        const notificationId = decodeURIComponent(readMatch[1]);
        sendJson(
          response,
          200,
          mockNotifications.markNotificationRead(notificationId, context),
        );
        return;
      }

      if (request.method === "GET" && path === "/notifications/settings") {
        sendJson(response, 200, mockNotifications.getNotificationSettings(context));
        return;
      }

      if (request.method === "PUT" && path === "/notifications/settings") {
        const payload = await readJson(request);
        sendJson(
          response,
          200,
          mockNotifications.updateNotificationSettings(context, payload),
        );
        return;
      }

      if (request.method === "POST" && path === "/internal/notifications/events") {
        const payload = await readJson(request);
        sendJson(response, 202, mockNotifications.acceptProducerEvent(payload));
        return;
      }

      sendJson(
        response,
        404,
        problem(404, "Not Found", "No Notification Platform route matched.", []),
      );
    } catch (error) {
      if (error instanceof C10DtoValidationError) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match C10 DTO.",
            error.errors,
          ),
        );
        return;
      }

      if (error instanceof C10NotificationNotFoundError) {
        sendJson(
          response,
          404,
          problem(404, "Not Found", error.message, [
            {
              field: "id",
              message: "Notification is not visible to the current user.",
            },
          ]),
        );
        return;
      }

      if (error instanceof PayloadError) {
        sendJson(response, error.status, problem(error.status, error.title, error.message, []));
        return;
      }

      sendJson(
        response,
        500,
        problem(500, "Internal Server Error", error.message, []),
      );
    }
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new PayloadError(413, "Payload Too Large", "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PayloadError(400, "Invalid JSON", "Request body must be valid JSON.");
  }
}

function normalizeApiPath(path) {
  if (path === "/api/v1") {
    return "/";
  }

  if (path.startsWith("/api/v1/")) {
    return path.slice("/api/v1".length);
  }

  return path;
}

function requestContext(request) {
  return {
    requestId: header(request, "x-request-id") ?? "req-notification-m0",
    organizationId: header(request, "x-bridge-organization-id") ?? "org-1",
    userId: header(request, "x-bridge-user-id") ?? "manager-1",
  };
}

function header(request, name) {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function queryObject(searchParams) {
  return Object.fromEntries(searchParams.entries());
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  });
  response.end(body);
}

function problem(status, title, detail, errors) {
  return {
    type: `https://bridge.local/problems/${title
      .toLowerCase()
      .replaceAll(" ", "-")}`,
    title,
    status,
    detail,
    errors,
  };
}

function renderMetrics(metrics) {
  const lines = [
    "# HELP notification_platform_mock_list_total C10 notification list requests served by the deterministic mock.",
    "# TYPE notification_platform_mock_list_total counter",
    `notification_platform_mock_list_total ${metrics.list_total}`,
    "# HELP notification_platform_mock_mark_read_total C10 notification read acknowledgements served by the deterministic mock.",
    "# TYPE notification_platform_mock_mark_read_total counter",
    `notification_platform_mock_mark_read_total ${metrics.mark_read_total}`,
    "# HELP notification_platform_mock_producer_event_total Producer notification trigger events accepted by the deterministic mock.",
    "# TYPE notification_platform_mock_producer_event_total counter",
    `notification_platform_mock_producer_event_total ${metrics.producer_event_total}`,
    "# HELP notification_platform_mock_duplicate_total Duplicate producer events deduplicated without creating a second notification.",
    "# TYPE notification_platform_mock_duplicate_total counter",
    `notification_platform_mock_duplicate_total ${metrics.duplicate_total}`,
    "# HELP notification_platform_mock_delivery_total Channel deliveries dispatched for accepted notifications.",
    "# TYPE notification_platform_mock_delivery_total counter",
    `notification_platform_mock_delivery_total{channel="web"} ${metrics.delivery_web_total}`,
    `notification_platform_mock_delivery_total{channel="telegram"} ${metrics.delivery_telegram_total}`,
    `notification_platform_mock_delivery_total{channel="email"} ${metrics.delivery_email_total}`,
    `notification_platform_mock_delivery_total{channel="push"} ${metrics.delivery_push_total}`,
    "# HELP notification_platform_mock_delivery_skipped_total Channel deliveries skipped because the subscription is disabled.",
    "# TYPE notification_platform_mock_delivery_skipped_total counter",
    `notification_platform_mock_delivery_skipped_total ${metrics.delivery_skipped_total}`,
  ];

  return `${lines.join("\n")}\n`;
}

class PayloadError extends Error {
  constructor(status, title, message) {
    super(message);
    this.name = "PayloadError";
    this.status = status;
    this.title = title;
  }
}
