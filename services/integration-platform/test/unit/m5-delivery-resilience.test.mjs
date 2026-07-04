import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBackoffPolicy } from "../../src/delivery/backoff.mjs";
import { createDeliveryEngine } from "../../src/delivery/delivery-engine.mjs";

function egressDelivery({
  messageId,
  channelType = "telegram",
  organizationId = "11111111-1111-1111-1111-111111111111",
}) {
  return {
    contract: "C2.EgressDelivery",
    version: "1.0.0",
    idempotency_key: messageId,
    channel_id: `chan-${channelType}`,
    message: {
      message_id: messageId,
      organization_id: organizationId,
      channel_id: `chan-${channelType}`,
      channel_type: channelType,
      direction: "outbound",
      conversation_ref: `conv-${channelType}`,
      content: { type: "text", text: "hello" },
    },
  };
}

function recordingBackendClient() {
  const attempts = [];
  return {
    attempts,
    async recordAttempt(attempt) {
      attempts.push({ ...attempt });
      return { recorded: true };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("M5 delivery resilience — timeout, circuit breaker и bulkhead", () => {
  it("таймаут переводит канал в деградацию, открывает circuit breaker и не бросает исключение наружу", async () => {
    const backend = recordingBackendClient();
    let calls = 0;
    const channel = {
      async deliver() {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 1 }),
      resilience: {
        timeoutMs: 5,
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
        bulkhead: { maxConcurrent: 1, maxQueue: 0 },
      },
    });

    const first = await engine.deliver(
      egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000005001" }),
    );
    assert.equal(first.delivered, false);
    assert.equal(first.error_category, "timeout");
    assert.equal(first.retryable, true);
    assert.equal(backend.attempts[0].status, "failed");

    const second = await engine.deliver(
      egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000005002" }),
    );
    assert.equal(second.delivered, false);
    assert.equal(second.error_category, "circuit_open");
    assert.equal(calls, 1, "open circuit breaker must reject without calling external API");

    const metrics = engine.getMetrics();
    assert.equal(metrics.timeout_total, 1);
    assert.equal(metrics.circuit_open_total, 1);
    assert.equal(engine.getChannelState("telegram").circuit, "open");
  });

  it("bulkhead ограничивает параллелизм одного падающего канала и не блокирует другой канал", async () => {
    const backend = recordingBackendClient();
    const held = deferred();
    const calls = [];
    const channel = {
      async deliver({ channelType }) {
        calls.push(channelType);
        if (channelType === "telegram") {
          await held.promise;
        }
        return { external_message_id: `ext-${channelType}` };
      },
    };
    const engine = createDeliveryEngine({
      channel,
      backendClient: backend,
      backoff: createBackoffPolicy({ maxAttempts: 1 }),
      resilience: {
        timeoutMs: 1000,
        circuitBreaker: { failureThreshold: 5 },
        bulkhead: { maxConcurrent: 1, maxQueue: 0 },
      },
    });

    const firstTelegram = engine.deliver(
      egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000005003" }),
    );
    await Promise.resolve();

    const secondTelegram = await engine.deliver(
      egressDelivery({ messageId: "aaaaaaaa-0000-0000-0000-000000005004" }),
    );
    assert.equal(secondTelegram.delivered, false);
    assert.equal(secondTelegram.error_category, "bulkhead_full");

    const email = await engine.deliver(
      egressDelivery({
        messageId: "aaaaaaaa-0000-0000-0000-000000005005",
        channelType: "email",
      }),
    );
    assert.equal(email.delivered, true);
    assert.deepEqual(calls, ["telegram", "email"]);

    held.resolve();
    const firstResult = await firstTelegram;
    assert.equal(firstResult.delivered, true);
    assert.equal(engine.getMetrics().bulkhead_rejected_total, 1);
  });
});
