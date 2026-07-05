import { createServer } from "node:http";

import { C5DtoValidationError } from "./c5-dto.js";
import { createDeterministicFbpMock } from "./deterministic-fbp.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

export function createFbpEngineServer({
  fbp,
  now = () => new Date().toISOString(),
} = {}) {
  const mockFbp = fbp ?? createDeterministicFbpMock({ now });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fbp-engine.local");
      const path = normalizeApiPath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "fbp-engine",
          mode: "deterministic-mock",
          contract: "C5",
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderMetrics(mockFbp.getMetrics()));
        return;
      }

      const startMatch = path.match(/^\/workflows\/([^/]+)\/instances$/);
      if (request.method === "POST" && startMatch) {
        const workflowId = decodeURIComponent(startMatch[1]);
        const payload = await readJson(request);
        sendJson(response, 201, mockFbp.startWorkflow(workflowId, payload));
        return;
      }

      const callbackMatch = path.match(
        /^\/workflows\/([^/]+)\/instances\/([^/]+)\/backend-api-callbacks$/,
      );
      if (request.method === "POST" && callbackMatch) {
        const workflowId = decodeURIComponent(callbackMatch[1]);
        const instanceId = decodeURIComponent(callbackMatch[2]);
        const payload = await readJson(request);

        if (
          isRecord(payload) &&
          (payload.workflow_id !== workflowId || payload.instance_id !== instanceId)
        ) {
          throw new PayloadError(
            400,
            "Validation failed",
            "Callback path parameters must match workflow_id and instance_id.",
          );
        }

        sendJson(response, 200, mockFbp.recordBackendApiCallback(payload));
        return;
      }

      sendJson(
        response,
        404,
        problem(404, "Not Found", "No FBP Engine route matched.", []),
      );
    } catch (error) {
      if (error instanceof C5DtoValidationError) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match C5 DTO.",
            error.errors,
          ),
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
    "# HELP fbp_engine_mock_workflow_start_total C5 workflow starts served by the deterministic mock.",
    "# TYPE fbp_engine_mock_workflow_start_total counter",
    `fbp_engine_mock_workflow_start_total ${metrics.workflow_start_total}`,
    "# HELP fbp_engine_mock_backend_api_callback_total C5 Backend API node callbacks recorded by the deterministic mock.",
    "# TYPE fbp_engine_mock_backend_api_callback_total counter",
    `fbp_engine_mock_backend_api_callback_total ${metrics.backend_api_callback_total}`,
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
