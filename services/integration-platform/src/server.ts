import { createServer } from "node:http";

import { createMockAdapter } from "./adapters/mock/mock-adapter.js";
import { isWebChatEgressDelivery } from "./adapters/web-chat/web-chat-adapter.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Опции {@link createIntegrationPlatformServer}. */
export interface IntegrationPlatformServerOptions {
  adapter?: any;
  webChatAdapter?: any;
  adapters?: Record<string, any>;
  deliveryEngine?: any;
  deliveryDispatchMode?: string;
}

export function createIntegrationPlatformServer({
  adapter = createMockAdapter({
    coreIngressUrl: process.env.CORE_INGRESS_URL,
  }),
  webChatAdapter,
  adapters = {},
  deliveryEngine,
  deliveryDispatchMode = "sync",
}: IntegrationPlatformServerOptions = {}) {
  const channelAdapters = createChannelAdapterRegistry({ adapters, webChatAdapter });

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
        sendText(
          response,
          200,
          renderMetrics(adapter.getMetrics(), deliveryEngine?.getMetrics()),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/mock/capabilities") {
        sendJson(response, 200, adapter.capabilityDescriptor);
        return;
      }

      if (request.method === "POST" && url.pathname === "/mock/incoming/messages") {
        const payload = await readJson(request);
        const result = await adapter.emulateIncomingMessage(payload);
        sendJson(response, 202, result);
        return;
      }

      const channelRoute = findChannelRoute(url.pathname, channelAdapters);
      if (request.method === "GET" && channelRoute?.action === "capabilities") {
        sendJson(response, 200, channelRoute.adapter.capabilityDescriptor);
        return;
      }

      if (request.method === "POST" && channelRoute?.action === "incoming") {
        const payload = await readJson(request);
        try {
          const result = await channelRoute.adapter.publishIncomingMessage(payload);
          sendJson(response, 202, result);
        } catch (error) {
          if (error instanceof TypeError) {
            sendJson(response, 400, {
              accepted: false,
              errors: [error.message],
            });
            return;
          }

          throw error;
        }
        return;
      }

      if (request.method === "POST" && isWebChatIncomingPath(url.pathname)) {
        const currentWebChatAdapter = ensureWebChatAdapter(webChatAdapter);
        const payload = await readJson(request);
        try {
          const result = await currentWebChatAdapter.publishIncomingMessage(payload);
          sendJson(response, 202, result);
        } catch (error) {
          if (error instanceof TypeError) {
            sendJson(response, 400, {
              accepted: false,
              errors: [error.message],
            });
            return;
          }

          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/egress/deliveries") {
        const payload = await readJson(request);
        const egressAdapter = resolveEgressAdapter(payload, channelAdapters, {
          adapter,
          webChatAdapter,
        });
        const result = await egressAdapter.acceptEgressDelivery(payload);
        sendJson(response, result.accepted ? 202 : 400, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/delivery/dispatch") {
        if (!deliveryEngine) {
          sendJson(response, 503, {
            error: "delivery_engine_unavailable",
            message: "delivery engine is not configured",
          });
          return;
        }

        const payload = await readJson(request);
        try {
          if (
            deliveryDispatchMode === "async" &&
            typeof deliveryEngine.enqueue === "function"
          ) {
            const result = deliveryEngine.enqueue(payload);
            sendJson(response, result.accepted ? 202 : 503, result);
            return;
          }

          const result = await deliveryEngine.deliver(payload);
          sendJson(response, result.delivered ? 202 : 502, result);
        } catch (error) {
          if (error instanceof TypeError) {
            sendJson(response, 400, {
              delivered: false,
              errors: [error.message],
            });
            return;
          }

          throw error;
        }
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

function createChannelAdapterRegistry({ adapters, webChatAdapter }) {
  const registry = new Map();

  for (const [channelType, channelAdapter] of Object.entries(adapters ?? {})) {
    if (channelAdapter) {
      registry.set(channelType, channelAdapter);
    }
  }

  if (webChatAdapter) {
    registry.set("web_chat", webChatAdapter);
  }

  return registry;
}

function ensureWebChatAdapter(adapter) {
  if (!adapter) {
    throw new Error("webChatAdapter is required for Web Chat routes");
  }

  return adapter;
}

function isWebChatIncomingPath(pathname) {
  return pathname === "/web-chat/incoming/messages" || pathname === "/web-chat/messages";
}

function findChannelRoute(pathname, channelAdapters) {
  for (const [channelType, channelAdapter] of channelAdapters.entries()) {
    const pathSegment = channelType.replaceAll("_", "-");
    if (pathname === `/${pathSegment}/capabilities`) {
      return {
        action: "capabilities",
        adapter: channelAdapter,
        channelType,
      };
    }
    if (pathname === `/${pathSegment}/incoming/messages`) {
      return {
        action: "incoming",
        adapter: channelAdapter,
        channelType,
      };
    }
  }

  return null;
}

function resolveEgressAdapter(payload, channelAdapters, { adapter, webChatAdapter }) {
  const channelType = payload?.message?.channel_type ?? payload?.message?.channel;
  if (typeof channelType === "string" && channelAdapters.has(channelType)) {
    return channelAdapters.get(channelType);
  }

  if (webChatAdapter && isWebChatEgressDelivery(payload)) {
    return webChatAdapter;
  }

  return adapter;
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

function renderMetrics(metrics, deliveryMetrics) {
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

  if (deliveryMetrics) {
    for (const [name, help] of Object.entries(DELIVERY_METRIC_HELP)) {
      if (deliveryMetrics[name] === undefined) {
        continue;
      }
      const metricName = `integration_platform_delivery_${name}`;
      lines.push(
        `# HELP ${metricName} ${help}`,
        `# TYPE ${metricName} counter`,
        `${metricName} ${deliveryMetrics[name]}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

const DELIVERY_METRIC_HELP = Object.freeze({
  deliveries_total: "Total egress deliveries handed to the delivery engine.",
  delivered_total: "Deliveries that reached the external channel.",
  failed_total: "Deliveries that failed after exhausting retries or on permanent errors.",
  duplicate_total: "Deliveries skipped as idempotent duplicates.",
  retries_total: "Retry attempts triggered by retryable errors.",
  attempts_total: "Delivery attempts recorded in message_delivery_attempts.",
  attempt_record_failures_total: "Failures to record a delivery attempt via Backend.",
  queued_total: "Deliveries accepted into the asynchronous retry queue.",
  queue_retries_total: "Asynchronous queue retries scheduled after degraded delivery attempts.",
  degraded_total: "Retryable degraded delivery outcomes observed for external channels.",
  timeout_total: "External channel calls rejected by the delivery timeout.",
  circuit_open_total: "External channel calls rejected by an open circuit breaker.",
  bulkhead_rejected_total: "External channel calls rejected by bulkhead limits.",
});
