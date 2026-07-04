import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  createBroadcastDeliveryCoordinator,
  createCommunicationCoreM1Service,
} from "../../../backend/src/modules/communication-core/index.mjs";
import {
  createBroadcastRateLimiter,
  createCampaignRunner,
} from "../../src/campaign/index.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000501";
const BROADCAST_ID = "50000000-0000-4000-8000-000000000501";
const RECIPIENTS = 240;
const FAILED_EVERY = 10;

const broadcast = {
  id: BROADCAST_ID,
  organization_id: ORGANIZATION_ID,
  status: "scheduled",
  template: { type: "text", body: "M5 нагрузочный пробник для {{client.name}}" },
  rate_limit: {
    messages_per_minute: 120,
    burst: 24,
    strategy: "fixed",
  },
};

function createIsoClock() {
  let tick = 0;
  const startedAt = Date.parse("2026-07-04T14:00:00.000Z");
  return () => new Date(startedAt + tick++).toISOString();
}

function createVirtualRateLimiter() {
  let current = 0;
  return {
    now: () => current,
    limiter: createBroadcastRateLimiter({
      now: () => current,
      sleep: async (ms) => {
        current += ms;
      },
    }),
  };
}

function canonicalInbound({ index }) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `40000000-0000-4000-8000-${suffix}`,
    idempotency_key: `40000000-0000-4000-8000-${suffix}`,
    organization_id: ORGANIZATION_ID,
    conversation_id: `20000000-0000-4000-8000-${suffix}`,
    endpoint_id: `10000000-0000-4000-8000-${suffix}`,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: 1,
    type: "text",
    content: { text: `seed ${index}` },
    status: "received",
    created_at: "2026-07-04T13:00:00.000Z",
    updated_at: "2026-07-04T13:00:00.000Z",
    metadata: {},
  };
}

async function seedRecipient(core, index) {
  const inbound = await core.acceptIngressMessage(canonicalInbound({ index }));
  return {
    client_id: `client-${index}`,
    endpoint_id: inbound.endpoint_id,
    conversation_id: inbound.conversation_id,
    channel: "web_chat",
    sequence_number: 1,
    context: { client: { name: `Клиент ${index}` } },
  };
}

function recipientIndexFromDelivery(delivery) {
  return Number.parseInt(delivery.message.conversation_ref.slice(-12), 10);
}

function countBy(items, field) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item[field], (counts.get(item[field]) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

describe("SVC-BCAST M5 — нагрузка и устойчивость крупных кампаний (CP-9)", { timeout: 30_000 }, () => {
  it("держит rate limit, фиксирует частичный отказ адаптера и повторяется без дублей", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createIsoClock() });
    const recipients = [];
    for (let index = 1; index <= RECIPIENTS; index += 1) {
      recipients.push(await seedRecipient(core, index));
    }

    const failingRecipients = new Set(
      Array.from({ length: RECIPIENTS / FAILED_EVERY }, (_unused, index) =>
        (index + 1) * FAILED_EVERY,
      ),
    );
    const attemptsByRecipient = new Map();
    let adapterCalls = 0;
    const adapter = {
      async deliver(delivery) {
        adapterCalls += 1;
        const index = recipientIndexFromDelivery(delivery);
        attemptsByRecipient.set(index, (attemptsByRecipient.get(index) ?? 0) + 1);
        if (failingRecipients.has(index)) {
          throw new Error("adapter timeout");
        }
        return { accepted: true, status: "sent" };
      },
    };

    const coordinator = createBroadcastDeliveryCoordinator({
      store,
      egressAdapter: adapter,
      clock: createIsoClock(),
      maxAttempts: 2,
    });
    const rateProbe = createVirtualRateLimiter();
    const runner = createCampaignRunner({
      core: coordinator,
      rateLimiter: rateProbe.limiter,
      clock: createIsoClock(),
      sleep: async () => {},
      batchSize: 40,
      coreMaxAttempts: 2,
    });

    const first = await runner.run(broadcast, recipients, {
      startIdempotencyKey: "m5-load-start",
    });

    const failed = failingRecipients.size;
    const sent = RECIPIENTS - failed;
    const expectedAdapterAttempts = sent + failed * 2;
    assert.equal(first.status, "done", "частичный отказ не блокирует кампанию целиком");
    assert.deepEqual(
      {
        prepared: first.stats.prepared,
        sent: first.stats.sent,
        failed: first.stats.failed,
        batches: first.batches,
      },
      {
        prepared: RECIPIENTS,
        sent,
        failed,
        batches: 6,
      },
    );
    assert.equal(adapterCalls, expectedAdapterAttempts);
    assert.equal(attemptsByRecipient.get(1), 1, "успешный получатель доставлен с первой попытки");
    for (const failedRecipient of failingRecipients) {
      assert.equal(
        attemptsByRecipient.get(failedRecipient),
        2,
        "недоступный адаптер исчерпал maxAttempts=2",
      );
    }
    assert.equal(store.getBroadcastMessages().length, RECIPIENTS, "сообщения кампании не потеряны");
    assert.equal(
      new Set(store.getBroadcastMessages().map((link) => link.message_id)).size,
      RECIPIENTS,
      "broadcast_messages не содержит дублей",
    );
    assert.deepEqual(countBy(store.getBroadcastMessages(), "status"), {
      sent,
      failed,
    });
    assert.equal(store.getDeliveryAttempts().length, expectedAdapterAttempts);

    const limiterMetrics = rateProbe.limiter.getMetrics();
    const measurement = {
      recipients: RECIPIENTS,
      batches: first.batches,
      channel_limit_per_minute: broadcast.rate_limit.messages_per_minute,
      burst: broadcast.rate_limit.burst,
      virtual_wait_ms: rateProbe.now(),
      limiter_acquired: limiterMetrics.acquired_total,
      limiter_throttled: limiterMetrics.throttled_total,
      adapter_attempts: adapterCalls,
      sent: first.stats.sent,
      failed: first.stats.failed,
    };
    assert.deepEqual(measurement, {
      recipients: 240,
      batches: 6,
      channel_limit_per_minute: 120,
      burst: 24,
      virtual_wait_ms: 108_000,
      limiter_acquired: 240,
      limiter_throttled: 216,
      adapter_attempts: 264,
      sent: 216,
      failed: 24,
    });

    const adapterCallsBeforeRepeat = adapterCalls;
    const attemptsBeforeRepeat = store.getDeliveryAttempts().length;
    const linksBeforeRepeat = store.getBroadcastMessages().length;
    const second = await runner.run(broadcast, recipients, {
      startIdempotencyKey: "m5-load-start",
    });

    assert.equal(second.stats.sent, sent);
    assert.equal(second.stats.failed, failed);
    assert.ok(second.results.every((result) => result.duplicate === true));
    assert.equal(adapterCalls, adapterCallsBeforeRepeat, "повтор не вызывает адаптер снова");
    assert.equal(store.getDeliveryAttempts().length, attemptsBeforeRepeat);
    assert.equal(store.getBroadcastMessages().length, linksBeforeRepeat);
  });
});
