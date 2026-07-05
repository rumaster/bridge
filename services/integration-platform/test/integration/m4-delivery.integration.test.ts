import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { createIntegrationPlatformServer } from "../../src/server.js";
import {
  createBackendDeliveryClient,
  createBackoffPolicy,
  createChannelRateLimiter,
  createDeliveryEngine,
  createMockExternalChannel,
} from "../../src/delivery/index.js";

const JSON_HEADERS = { "content-type": "application/json" };

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

function egressDelivery({ messageId, channelType = "telegram", text = "hello" }) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: "chan-1",
    message: {
      message_id: messageId,
      organization_id: "11111111-1111-1111-1111-111111111111",
      channel_id: "chan-1",
      channel_type: channelType,
      direction: "outbound",
      conversation_ref: "conv-1",
      content: { type: "text", text },
    },
  };
}

describe("M4 SVC-INT доставка: Backend <-> Integration через мок внешнего API (CP-6)", () => {
  // Мок Backend, фиксирующий записи в message_delivery_attempts.
  let backendServer;
  let backendBaseUrl;
  let recordedAttempts;
  let rejectAttemptOnce;

  let channel;
  let deliveryEngine;
  let integrationServer;
  let integrationBaseUrl;

  before(async () => {
    backendServer = createServer(async (request, response) => {
      if (
        request.method === "POST" &&
        request.url === "/internal/delivery/attempts"
      ) {
        const body = await readJson(request);
        if (rejectAttemptOnce) {
          rejectAttemptOnce = false;
          response.writeHead(503, JSON_HEADERS);
          response.end(JSON.stringify({ error: "backend_unavailable" }));
          return;
        }
        recordedAttempts.push(body);
        response.writeHead(201, JSON_HEADERS);
        response.end(JSON.stringify({ recorded: true }));
        return;
      }
      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    backendBaseUrl = await listen(backendServer);
  });

  beforeEach(async () => {
    recordedAttempts = [];
    rejectAttemptOnce = false;
    channel = createMockExternalChannel();
    deliveryEngine = createDeliveryEngine({
      channel,
      backendClient: createBackendDeliveryClient({ baseUrl: backendBaseUrl }),
      rateLimiter: createChannelRateLimiter({
        limits: {
          telegram: { capacity: 2, refillTokens: 2, refillIntervalMs: 1000 },
          sms: { capacity: 100, refillTokens: 100, refillIntervalMs: 1000 },
        },
      }),
      backoff: createBackoffPolicy({ baseDelayMs: 1, factor: 2, maxAttempts: 5 }),
      sleep: async () => {},
    });
    if (integrationServer) {
      await close(integrationServer);
    }
    integrationServer = createIntegrationPlatformServer({ deliveryEngine });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    if (integrationServer) {
      await close(integrationServer);
    }
    await close(backendServer);
  });

  async function dispatch(payload) {
    const response = await fetch(`${integrationBaseUrl}/internal/delivery/dispatch`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const body: any = await response.json();
    return { status: response.status, body };
  }

  it("доставляет сообщение и фиксирует попытку в message_delivery_attempts", async () => {
    const messageId = "bbbbbbbb-0000-0000-0000-000000000001";
    const { status, body } = await dispatch(egressDelivery({ messageId }));

    assert.equal(status, 202);
    assert.equal(body.delivered, true);
    assert.equal(body.attempts, 1);
    assert.equal(channel.deliveredCount, 1);

    assert.equal(recordedAttempts.length, 1);
    const attempt = recordedAttempts[0];
    assert.equal(attempt.contract, "C2.DeliveryAttempt");
    assert.equal(attempt.message_id, messageId);
    assert.equal(attempt.adapter, "telegram");
    assert.equal(attempt.attempt_no, 1);
    assert.equal(attempt.status, "delivered");
  });

  it("повторяет доставку без дубля внешнего сообщения (ретрай + идемпотентность)", async () => {
    // Ошибка мока внешнего канала на первой попытке (503) -> ретрай.
    const messageId = "bbbbbbbb-0000-0000-0000-000000000002";
    channel = createMockExternalChannel({
      outcomes: { [messageId]: [{ status: 503, retryable: true }] },
    });
    deliveryEngine = createDeliveryEngine({
      channel,
      backendClient: createBackendDeliveryClient({ baseUrl: backendBaseUrl }),
      backoff: createBackoffPolicy({ baseDelayMs: 1, maxAttempts: 5 }),
      sleep: async () => {},
    });
    await close(integrationServer);
    integrationServer = createIntegrationPlatformServer({ deliveryEngine });
    integrationBaseUrl = await listen(integrationServer);

    const { status, body } = await dispatch(egressDelivery({ messageId }));
    assert.equal(status, 202);
    assert.equal(body.delivered, true);
    assert.equal(body.attempts, 2);
    // Ровно одно внешнее сообщение, несмотря на ретрай.
    assert.equal(channel.deliveredCount, 1);
    // Две записи попыток: failed + delivered.
    const statuses = recordedAttempts
      .filter((a) => a.message_id === messageId)
      .map((a) => a.status);
    assert.deepEqual(statuses, ["failed", "delivered"]);
  });

  it("отбрасывает повторную доставку с уже обработанным idempotency_key", async () => {
    const messageId = "bbbbbbbb-0000-0000-0000-000000000003";
    const first = await dispatch(egressDelivery({ messageId }));
    const second = await dispatch(egressDelivery({ messageId }));

    assert.equal(first.body.delivered, true);
    assert.equal(second.status, 202);
    assert.equal(second.body.duplicate, true);
    // Ни одного нового внешнего сообщения, ни одной новой записи попытки.
    assert.equal(channel.deliveredCount, 1);
    assert.equal(recordedAttempts.length, 1);
  });

  it("применяет rate limiting на канал и продолжает доставлять при backpressure", async () => {
    // Лимит telegram = 2 токена/сек; 3 сообщения -> третье ждёт пополнения.
    const ids = [
      "bbbbbbbb-0000-0000-0000-00000000000a",
      "bbbbbbbb-0000-0000-0000-00000000000b",
      "bbbbbbbb-0000-0000-0000-00000000000c",
    ];
    const results = await Promise.all(
      ids.map((messageId) => dispatch(egressDelivery({ messageId }))),
    );

    for (const result of results) {
      assert.equal(result.status, 202);
      assert.equal(result.body.delivered, true);
    }
    assert.equal(channel.deliveredCount, 3);

    const metricsResponse = await fetch(`${integrationBaseUrl}/metrics`);
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /integration_platform_delivery_delivered_total 3/);
  });

  it("не роняет доставку при недоступности Backend (best-effort фиксация)", async () => {
    rejectAttemptOnce = true;
    const messageId = "bbbbbbbb-0000-0000-0000-000000000004";
    const { status, body } = await dispatch(egressDelivery({ messageId }));

    assert.equal(status, 202);
    assert.equal(body.delivered, true);
    assert.equal(channel.deliveredCount, 1);
    const metricsResponse = await fetch(`${integrationBaseUrl}/metrics`);
    assert.match(
      await metricsResponse.text(),
      /integration_platform_delivery_attempt_record_failures_total 1/,
    );
  });

  it("возвращает 400 при несовпадении idempotency_key и message_id", async () => {
    const delivery = egressDelivery({
      messageId: "bbbbbbbb-0000-0000-0000-000000000005",
    });
    delivery.idempotency_key = "mismatch";
    const { status, body } = await dispatch(delivery);
    assert.equal(status, 400);
    assert.equal(body.delivered, false);
  });
});
