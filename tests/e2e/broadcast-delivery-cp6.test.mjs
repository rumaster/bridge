import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createIntegrationPlatformServer } from "../../services/integration-platform/src/server.mjs";
import {
  createBackendDeliveryClient,
  createBackoffPolicy,
  createChannelRateLimiter,
  createDeliveryEngine,
  createMockExternalChannel,
} from "../../services/integration-platform/src/delivery/index.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000601";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
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

// Модель одного получателя кампании (генерация кампании остаётся в SVC-BCAST —
// здесь проверяется только массовая доставка через SVC-INT, CP-6).
function campaignRecipient(index) {
  const messageId = `10000000-0000-4000-8000-0000000006${String(index).padStart(2, "0")}`;
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: "channel-telegram",
    message: {
      message_id: messageId,
      organization_id: ORGANIZATION_ID,
      channel_id: "channel-telegram",
      channel_type: "telegram",
      direction: "outbound",
      conversation_ref: `telegram-chat-${index}`,
      content: { type: "text", text: `Рассылка №${index}` },
    },
  };
}

describe("CP-6 Broadcast: доставка кампании с ретраями и лимитами (M4)", () => {
  let backendServer;
  let backendBaseUrl;
  let recordedAttempts;
  let channel;
  let deliveryEngine;
  let integrationServer;
  let integrationBaseUrl;

  const RECIPIENTS = 6;
  // У получателя №3 первая попытка внешнего API падает с 503 (повторяемо):
  // движок обязан повторить доставку без создания второго сообщения.
  const FLAKY_INDEX = 3;

  before(async () => {
    recordedAttempts = [];
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

    const flakyId = campaignRecipient(FLAKY_INDEX).idempotency_key;
    channel = createMockExternalChannel({
      outcomes: { [flakyId]: [{ status: 503, retryable: true }] },
    });

    deliveryEngine = createDeliveryEngine({
      channel,
      backendClient: createBackendDeliveryClient({ baseUrl: backendBaseUrl }),
      // Лимит канала telegram = 2 сообщения/сек: кампания из 6 сообщений
      // упирается в backpressure и доставляется порциями (изоляция нагрузки).
      rateLimiter: createChannelRateLimiter({
        limits: {
          telegram: { capacity: 2, refillTokens: 2, refillIntervalMs: 50 },
        },
      }),
      backoff: createBackoffPolicy({ baseDelayMs: 1, factor: 2, maxAttempts: 5 }),
      sleep: async () => {},
    });

    integrationServer = createIntegrationPlatformServer({ deliveryEngine });
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
    });
    return { status: response.status, body: await response.json() };
  }

  it("доставляет всю кампанию: ретрай без дублей, лимиты, фиксация попыток", async () => {
    const recipients = Array.from({ length: RECIPIENTS }, (_, i) =>
      campaignRecipient(i + 1),
    );

    const results = await Promise.all(recipients.map((r) => dispatch(r)));

    // Все получатели доставлены.
    for (const result of results) {
      assert.equal(result.status, 202);
      assert.equal(result.body.delivered, true);
    }

    // Ровно по одному внешнему сообщению на получателя — дублей нет,
    // несмотря на ретрай «шаткого» получателя (ТЗ §11.12).
    assert.equal(channel.deliveredCount, RECIPIENTS);

    // «Шаткий» получатель доставлен со второй попытки.
    const flakyResult = results[FLAKY_INDEX - 1];
    assert.equal(flakyResult.body.attempts, 2);

    // Все попытки зафиксированы в message_delivery_attempts через Backend:
    // по одной на успешных + одна дополнительная (failed) на «шаткого».
    assert.equal(recordedAttempts.length, RECIPIENTS + 1);
    const delivered = recordedAttempts.filter((a) => a.status === "delivered");
    const failed = recordedAttempts.filter((a) => a.status === "failed");
    assert.equal(delivered.length, RECIPIENTS);
    assert.equal(failed.length, 1);
    assert.equal(
      failed[0].message_id,
      campaignRecipient(FLAKY_INDEX).idempotency_key,
    );

    const metrics = deliveryEngine.getMetrics();
    assert.equal(metrics.delivered_total, RECIPIENTS);
    assert.equal(metrics.failed_total, 0);
    assert.equal(metrics.retries_total, 1);
  });

  it("повторная отправка кампании идемпотентна (нет повторной доставки)", async () => {
    const deliveredBefore = channel.deliveredCount;
    const attemptsBefore = recordedAttempts.length;

    // Повторный запуск той же кампании (например, при рестарте SVC-BCAST).
    const recipients = Array.from({ length: RECIPIENTS }, (_, i) =>
      campaignRecipient(i + 1),
    );
    const results = await Promise.all(recipients.map((r) => dispatch(r)));

    for (const result of results) {
      assert.equal(result.status, 202);
      assert.equal(result.body.duplicate, true);
    }

    // Ни новых внешних сообщений, ни новых записей попыток.
    assert.equal(channel.deliveredCount, deliveredBefore);
    assert.equal(recordedAttempts.length, attemptsBefore);
  });
});
