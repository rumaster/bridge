import { createServer } from "node:http";

import { C4DtoValidationError } from "./c4-dto.mjs";
import { createDeterministicAiMock } from "./deterministic-ai.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

export function createAiPlatformServer({
  ai,
  now = () => new Date().toISOString(),
} = {}) {
  const mockAi = ai ?? createDeterministicAiMock({ now });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://ai-platform.local");
      const path = normalizeApiPath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "ai-platform",
          mode: "deterministic-mock",
          contract: "C4",
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderMetrics(mockAi.getMetrics()));
        return;
      }

      if (request.method === "POST" && path === "/ai/assistant:suggest") {
        const payload = await readJson(request);
        sendJson(response, 200, mockAi.suggestAssistant(payload));
        return;
      }

      if (request.method === "POST" && path === "/ai/onboarding:command") {
        const payload = await readJson(request);
        sendJson(response, 200, mockAi.createOnboardingCommand(payload));
        return;
      }

      sendJson(
        response,
        404,
        problem(404, "Not Found", "No AI Platform route matched.", []),
      );
    } catch (error) {
      if (error instanceof C4DtoValidationError) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match C4 DTO.",
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
    "# HELP ai_platform_mock_assistant_suggest_total C4 assistant suggestions served by the deterministic mock.",
    "# TYPE ai_platform_mock_assistant_suggest_total counter",
    `ai_platform_mock_assistant_suggest_total ${metrics.assistant_suggest_total}`,
    "# HELP ai_platform_mock_onboarding_command_total C4 onboarding commands served by the deterministic mock.",
    "# TYPE ai_platform_mock_onboarding_command_total counter",
    `ai_platform_mock_onboarding_command_total ${metrics.onboarding_command_total}`,
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
