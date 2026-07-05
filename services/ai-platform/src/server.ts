import { createServer } from "node:http";

import { C4DtoValidationError } from "./c4-dto.js";
import { createDeterministicAiMock } from "./deterministic-ai.js";
import { renderPrometheus } from "./metrics.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Options accepted by {@link createAiPlatformServer}. `ai` is the AI
 * implementation (RAG assistant or deterministic mock) injected in tests and
 * production; it is typed permissively (`any`) because the two variants expose
 * different optional surfaces and the server only feature-detects a method
 * (`getHealth`, `getMetrics`, ...) before calling it.
 */
export interface AiPlatformServerOptions {
  ai?: any;
  mode?: string;
  now?: () => string;
}

export function createAiPlatformServer({
  ai,
  mode,
  now = () => new Date().toISOString(),
}: AiPlatformServerOptions = {}) {
  const mockAi = ai ?? createDeterministicAiMock({ now });
  const serviceMode = mode ?? mockAi.mode ?? "deterministic-mock";

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://ai-platform.local");
      const path = normalizeApiPath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, buildHealth(mockAi, serviceMode));
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderPrometheus(mockAi.getMetrics(), breakerGauges(mockAi)));
        return;
      }

      if (request.method === "POST" && path === "/ai/assistant:suggest") {
        const payload = await readJson(request);
        sendJson(response, 200, await mockAi.suggestAssistant(payload));
        return;
      }

      if (request.method === "POST" && path === "/ai/onboarding:command") {
        const payload = await readJson(request);
        sendJson(response, 200, await mockAi.createOnboardingCommand(payload));
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

/**
 * Base liveness plus, when the AI implementation exposes it, degradation detail
 * (active provider/model and circuit-breaker state) for ТЗ §24.4. The M0
 * deterministic mock has no `getHealth`, so its health payload stays minimal.
 */
function buildHealth(mockAi, serviceMode) {
  const base = {
    status: "ok",
    service: "ai-platform",
    mode: serviceMode,
    contract: "C4",
  };

  if (typeof mockAi.getHealth === "function") {
    const detail = mockAi.getHealth();
    if (detail && typeof detail === "object") {
      return { ...base, ...detail };
    }
  }

  return base;
}

/**
 * Expose the LLM circuit-breaker state as a numeric gauge alongside the metric
 * counters, so alerting can fire when a provider trips open (ТЗ §11.2, §24.4).
 */
function breakerGauges(mockAi) {
  if (typeof mockAi.getHealth !== "function") {
    return {};
  }
  const breaker = mockAi.getHealth()?.llm?.breaker;
  if (!breaker || typeof breaker.state !== "string") {
    return {};
  }
  return { llm_circuit_breaker_open: breaker.state === "open" ? 1 : 0 };
}

class PayloadError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, message: string) {
    super(message);
    this.name = "PayloadError";
    this.status = status;
    this.title = title;
  }
}
