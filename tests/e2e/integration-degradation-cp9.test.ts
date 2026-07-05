import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createIntegrationPlatformServer } from "../../services/integration-platform/src/server.js";
import {
  createBackendDeliveryClient,
  createBackoffPolicy,
  createDeliveryEngine,
} from "../../services/integration-platform/src/delivery/index.js";

const JSON_HEADERS = { "content-type": "application/json" };
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000901";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function egressDelivery({ messageId, channelType }) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: `cp9-${channelType}`,
    message: {
      message_id: messageId,
      organization_id: ORGANIZATION_ID,
      channel_id: `cp9-${channelType}`,
      channel_type: channelType,
      direction: "outbound",
      conversation_ref: `cp9-${channelType}-conversation`,
      content: { type: "text", text: `CP-9 ${channelType}` },
    },
  };
}

async function eventually(assertion, { attempts = 50 } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("CP-9 Integration Platform: деградация внешнего API без блокировки ядра", () => {
  let backendServer;
  let backendBaseUrl;
  let recordedAttempts;
  let integrationServer;
  let integrationBaseUrl;
  let externalDeliveries;

  before(async () => {
    recordedAttempts = [];
    externalDeliveries = [];

    backendServer = createServer(async (request, response) => {
      if (
        request.method === "POST" &&
        request.url === "/internal/delivery/attempts"
      ) {
        recordedAttempts.push(await readJson(request));
        response.writeHead(201, JSON_HEADERS);
        response.end(JSON.stringify({ recorded: true }));
        return;
      }

      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    backendBaseUrl = await listen(backendServer);

    const externalChannel = {
      async deliver({ idempotencyKey, channelType }) {
        externalDeliveries.push({ idempotencyKey, channelType });
        if (channelType === "telegram") {
          return new Promise(() => {});
        }
        return { external_message_id: `ext-${channelType}-${idempotencyKey}` };
      },
    };

    const deliveryEngine = createDeliveryEngine({
      channel: externalChannel,
      backendClient: createBackendDeliveryClient({ baseUrl: backendBaseUrl }),
      backoff: createBackoffPolicy({ baseDelayMs: 1, maxAttempts: 1 }),
      resilience: {
        timeoutMs: 10,
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
        bulkhead: { maxConcurrent: 1, maxQueue: 0 },
      },
      queue: {
        enabled: true,
        concurrency: 2,
        maxAttempts: 2,
        retryDelayMs: 1,
      },
    });

    integrationServer = createIntegrationPlatformServer({
      deliveryEngine,
      deliveryDispatchMode: "async",
    });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(backendServer);
  });

  async function dispatch(payload) {
    const response = await fetch(`${integrationBaseUrl}/internal/delivery/dispatch`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1000),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  it("принимает недоступный канал в очередь, доставляет другой канал и публикует метрики деградации", async () => {
    const telegramId = "10000000-0000-4000-8000-000000000911";
    const emailId = "10000000-0000-4000-8000-000000000912";

    const telegram = await dispatch(
      egressDelivery({ messageId: telegramId, channelType: "telegram" }),
    );
    const email = await dispatch(
      egressDelivery({ messageId: emailId, channelType: "email" }),
    );

    assert.equal(telegram.status, 202);
    assert.equal(telegram.body.status, "queued");
    assert.equal(email.status, 202);
    assert.equal(email.body.status, "queued");

    await eventually(() => {
      assert.ok(
        recordedAttempts.filter(
          (attempt) => attempt.message_id === telegramId && attempt.status === "failed",
        ).length >= 2,
      );
      assert.ok(
        recordedAttempts.some(
          (attempt) => attempt.message_id === emailId && attempt.status === "delivered",
        ),
      );
      assert.ok(
        externalDeliveries.some((delivery) => delivery.channelType === "email"),
      );
    });

    const metricsResponse = await fetch(`${integrationBaseUrl}/metrics`);
    const metrics = await metricsResponse.text();
    assert.match(metrics, /integration_platform_delivery_queued_total 2/);
    assert.match(metrics, /integration_platform_delivery_timeout_total 1/);
    assert.match(metrics, /integration_platform_delivery_degraded_total 2/);
  });
});
