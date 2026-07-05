import { createServer } from "node:http";

import { C8DtoValidationError } from "./c8-dto.js";
import {
  BroadcastNotFoundError,
  createDeterministicBroadcastMock,
} from "./deterministic-broadcast.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

export function createBroadcastPlatformServer({
  broadcast,
  now = () => new Date().toISOString(),
} = {}) {
  const mockBroadcast = broadcast ?? createDeterministicBroadcastMock({ now });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://broadcast-platform.local");
      const path = normalizeApiPath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "broadcast-platform",
          mode: "deterministic-mock",
          contract: "C8",
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderMetrics(mockBroadcast.getMetrics()));
        return;
      }

      if (request.method === "GET" && path === "/broadcasts") {
        const organizationId = requiredQuery(url, "organization_id");
        sendJson(
          response,
          200,
          mockBroadcast.listBroadcasts({
            organizationId,
            requestId: url.searchParams.get("request_id") ?? undefined,
          }),
        );
        return;
      }

      if (request.method === "POST" && path === "/broadcasts") {
        const payload = await readJson(request);
        sendJson(response, 201, mockBroadcast.createBroadcast(payload));
        return;
      }

      const startMatch = path.match(/^\/broadcasts\/([^/]+):start$/);
      if (request.method === "POST" && startMatch) {
        const broadcastId = decodeURIComponent(startMatch[1]);
        const payload = await readJson(request);
        sendJson(response, 200, await mockBroadcast.startBroadcast(broadcastId, payload));
        return;
      }

      const statsMatch = path.match(/^\/broadcasts\/([^/]+)\/stats$/);
      if (request.method === "GET" && statsMatch) {
        const broadcastId = decodeURIComponent(statsMatch[1]);
        const organizationId = requiredQuery(url, "organization_id");
        sendJson(
          response,
          200,
          mockBroadcast.getStats({
            broadcastId,
            organizationId,
            requestId: url.searchParams.get("request_id") ?? undefined,
          }),
        );
        return;
      }

      const getMatch = path.match(/^\/broadcasts\/([^/]+)$/);
      if (request.method === "GET" && getMatch) {
        const broadcastId = decodeURIComponent(getMatch[1]);
        const organizationId = requiredQuery(url, "organization_id");
        sendJson(response, 200, {
          contract: "C8.GetBroadcastResponse",
          version: "1.0.0",
          request_id: url.searchParams.get("request_id") ?? "req-broadcast-get-mock",
          organization_id: organizationId,
          broadcast: mockBroadcast.getBroadcast(broadcastId, organizationId),
        });
        return;
      }

      sendJson(
        response,
        404,
        problem(404, "Not Found", "No Broadcast Platform route matched.", []),
      );
    } catch (error) {
      if (error instanceof C8DtoValidationError) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match C8 DTO.",
            error.errors,
          ),
        );
        return;
      }

      if (error instanceof PayloadError) {
        sendJson(response, error.status, problem(error.status, error.title, error.message, []));
        return;
      }

      if (error instanceof BroadcastNotFoundError) {
        sendJson(response, 404, problem(404, "Not Found", error.message, []));
        return;
      }

      sendJson(response, 500, problem(500, "Internal Server Error", error.message, []));
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

function requiredQuery(url, key) {
  const value = url.searchParams.get(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new PayloadError(400, "Validation failed", `${key} query parameter is required.`);
  }
  return value;
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
    "# HELP broadcast_platform_mock_broadcasts_list_total C8 broadcast lists served by the deterministic mock.",
    "# TYPE broadcast_platform_mock_broadcasts_list_total counter",
    `broadcast_platform_mock_broadcasts_list_total ${metrics.broadcasts_list_total}`,
    "# HELP broadcast_platform_mock_broadcasts_create_total C8 broadcast creates served by the deterministic mock.",
    "# TYPE broadcast_platform_mock_broadcasts_create_total counter",
    `broadcast_platform_mock_broadcasts_create_total ${metrics.broadcasts_create_total}`,
    "# HELP broadcast_platform_mock_broadcasts_start_total C8 broadcast starts served by the deterministic mock.",
    "# TYPE broadcast_platform_mock_broadcasts_start_total counter",
    `broadcast_platform_mock_broadcasts_start_total ${metrics.broadcasts_start_total}`,
    "# HELP broadcast_platform_mock_broadcasts_stats_total C8 broadcast stats served by the deterministic mock.",
    "# TYPE broadcast_platform_mock_broadcasts_stats_total counter",
    `broadcast_platform_mock_broadcasts_stats_total ${metrics.broadcasts_stats_total}`,
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
