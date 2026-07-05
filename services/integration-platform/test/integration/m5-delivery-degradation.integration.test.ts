import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createIntegrationPlatformServer } from "../../src/server.js";
import {
  createBackendDeliveryClient,
  createBackoffPolicy,
  createDeliveryEngine,
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

function egressDelivery({ messageId, channelType }) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: `chan-${channelType}`,
    message: {
      message_id: messageId,
      organization_id: "11111111-1111-1111-1111-111111111111",
      channel_id: `chan-${channelType}`,
      channel_type: channelType,
      direction: "outbound",
      conversation_ref: `conv-${channelType}`,
      content: { type: "text", text: `hello ${channelType}` },
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

describe("M5 SVC-INT деградация: внешний API недоступен, ядро не блокируется", () => {
  let backendServer;
  let backendBaseUrl;
  let recordedAttempts;
  let integrationServer;
  let integrationBaseUrl;
  let channelLog;

  before(async () => {
    recordedAttempts = [];
    channelLog = [];

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
        channelLog.push({ idempotencyKey, channelType });
        if (channelType === "telegram") {
          return new Promise(() => {});
        }
        return { external_message_id: `ext-${idempotencyKey}` };
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

  async function dispatch(payload, { signal } = {}) {
    const response = await fetch(`${integrationBaseUrl}/internal/delivery/dispatch`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
      signal,
    });
    return { status: response.status, body: await response.json() };
  }

  it("сразу принимает доставку в очередь и продолжает доставлять другой канал", async () => {
    const telegramId = "bbbbbbbb-0000-0000-0000-000000005001";
    const emailId = "bbbbbbbb-0000-0000-0000-000000005002";

    const telegram = await dispatch(
      egressDelivery({ messageId: telegramId, channelType: "telegram" }),
      { signal: AbortSignal.timeout(1000) },
    );
    assert.equal(telegram.status, 202);
    assert.equal(telegram.body.queued, true);
    assert.equal(telegram.body.delivered, false);

    const email = await dispatch(
      egressDelivery({ messageId: emailId, channelType: "email" }),
    );
    assert.equal(email.status, 202);
    assert.equal(email.body.queued, true);

    await eventually(() => {
      assert.ok(
        recordedAttempts.some(
          (attempt) => attempt.message_id === emailId && attempt.status === "delivered",
        ),
      );
      assert.ok(
        recordedAttempts.some(
          (attempt) => attempt.message_id === telegramId && attempt.status === "failed",
        ),
      );
    });

    assert.ok(
      channelLog.some((entry) => entry.channelType === "email"),
      "доставка email не должна ждать зависший telegram",
    );
  });
});
