import { createServer } from "node:http";

import { createMockAdapter } from "./adapters/mock/mock-adapter.mjs";
import {
  WebChatAdapterValidationError,
  createWebChatAdapter,
} from "./adapters/web-chat/web-chat-adapter.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function createIntegrationPlatformServer({
  adapter = createMockAdapter({
    coreIngressUrl: process.env.CORE_INGRESS_URL,
  }),
  webChatAdapter = createWebChatAdapter({
    coreIngressUrl: process.env.CORE_INGRESS_URL,
  }),
} = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://integration-platform.local");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "integration-platform",
          adapter: "mock-adapter",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        sendText(response, 200, renderMetrics(adapter.getMetrics()));
        return;
      }

      if (request.method === "GET" && url.pathname === "/mock/capabilities") {
        sendJson(response, 200, adapter.capabilityDescriptor);
        return;
      }

      if (request.method === "GET" && url.pathname === "/web-chat/capabilities") {
        sendJson(response, 200, webChatAdapter.capabilityDescriptor);
        return;
      }

      if (request.method === "POST" && url.pathname === "/web-chat/messages") {
        const payload = await readJson(request);
        try {
          const result = await webChatAdapter.publishIncomingMessage(payload);
          sendJson(response, 202, result);
        } catch (error) {
          if (error instanceof WebChatAdapterValidationError) {
            sendJson(response, 400, {
              accepted: false,
              errors: error.errors,
            });
            return;
          }

          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/mock/incoming/messages") {
        const payload = await readJson(request);
        const result = await adapter.emulateIncomingMessage(payload);
        sendJson(response, 202, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/egress/deliveries") {
        const payload = await readJson(request);
        const result = isWebChatDelivery(payload)
          ? await webChatAdapter.acceptEgressDelivery(payload)
          : await adapter.acceptEgressDelivery(payload);
        sendJson(response, result.accepted ? 202 : 400, result);
        return;
      }

      sendJson(response, 404, {
        error: "not_found",
        path: url.pathname,
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "internal_error",
        message: error.message,
      });
    }
  });
}

function isWebChatDelivery(payload) {
  return payload?.message?.channel_type === "web_chat";
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function renderMetrics(metrics) {
  const lines = [
    "# HELP integration_platform_mock_adapter_ingress_published_total C2 ingress messages published to core.",
    "# TYPE integration_platform_mock_adapter_ingress_published_total counter",
    `integration_platform_mock_adapter_ingress_published_total ${metrics.ingress_published_total}`,
    "# HELP integration_platform_mock_adapter_ingress_failed_total C2 ingress messages rejected by core.",
    "# TYPE integration_platform_mock_adapter_ingress_failed_total counter",
    `integration_platform_mock_adapter_ingress_failed_total ${metrics.ingress_failed_total}`,
    "# HELP integration_platform_mock_adapter_egress_accepted_total C2 egress deliveries accepted by the mock channel.",
    "# TYPE integration_platform_mock_adapter_egress_accepted_total counter",
    `integration_platform_mock_adapter_egress_accepted_total ${metrics.egress_accepted_total}`,
    "# HELP integration_platform_mock_adapter_egress_duplicate_total Duplicate C2 egress deliveries skipped by idempotency key.",
    "# TYPE integration_platform_mock_adapter_egress_duplicate_total counter",
    `integration_platform_mock_adapter_egress_duplicate_total ${metrics.egress_duplicate_total}`,
    "# HELP integration_platform_mock_adapter_egress_rejected_total Invalid C2 egress deliveries rejected by the adapter.",
    "# TYPE integration_platform_mock_adapter_egress_rejected_total counter",
    `integration_platform_mock_adapter_egress_rejected_total ${metrics.egress_rejected_total}`,
  ];

  return `${lines.join("\n")}\n`;
}
