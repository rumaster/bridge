import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createMobileBff } from "../../src/mobile-bff.mjs";
import { createMockPushProvider } from "../../src/push-provider.mjs";
import { createMobileApiServer } from "../../src/server.mjs";

const JSON_HEADERS = { "content-type": "application/json" };

// §25.2 — бюджеты латентности «экранных» ответов мобильного BFF.
const LATENCY_BUDGET_MS = { dialogs: 1000, history: 2000, notifications: 1000 };

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

function incrementingClock() {
  let tick = 0;
  return () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function sendMessageBody(overrides = {}) {
  return {
    contract: "MOBILE.SendMessageRequest",
    version: "1.0.0",
    request_id: "req-1",
    organization_id: "org-1",
    conversation_id: "conversation-1",
    message_id: "message-1",
    idempotency_key: "message-1",
    sender_user_id: "manager-1",
    text: "Hello",
    ...overrides,
  };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("SVC-MOB BFF integration — offline→online sync (§19.3)", () => {
  let server;
  let baseUrl;
  let bff;

  before(async () => {
    bff = createMobileBff({ now: incrementingClock() });
    server = createMobileApiServer({ mobileApi: bff });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("delivers every change accumulated while offline exactly once", async () => {
    // Клиент онлайн: берёт стартовый курсор на пустой ленте.
    const baseline = await (await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1`)).json();
    assert.equal(baseline.deltas.messages.length, 0);

    // Клиент офлайн: копятся два исходящих сообщения и уведомление C10.
    await postJson(baseUrl, "/mobile/v1/messages", sendMessageBody({ message_id: "message-1", idempotency_key: "message-1", request_id: "req-1" }));
    bff.backend.createNotification({
      organizationId: "org-1",
      notificationId: "notification-1",
      recipientUserId: "manager-1",
      title: "New client message",
      body: "Ada wrote to you",
    });
    await postJson(baseUrl, "/mobile/v1/messages", sendMessageBody({ message_id: "message-2", idempotency_key: "message-2", request_id: "req-2" }));

    // Клиент онлайн: догоняет по своему курсору — без потерь.
    const resumed = await (
      await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1&cursor=${encodeURIComponent(baseline.cursor)}`)
    ).json();
    assert.deepEqual(
      resumed.deltas.messages.map((m) => m.message_id).sort(),
      ["message-1", "message-2"],
    );
    assert.equal(resumed.deltas.notifications.length, 1);

    // Дальнейший sync по новому курсору — пусто, без дублей.
    const caughtUp = await (
      await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1&cursor=${encodeURIComponent(resumed.cursor)}`)
    ).json();
    assert.equal(caughtUp.deltas.messages.length, 0);
    assert.equal(caughtUp.deltas.notifications.length, 0);

    // Повторная докачка по старому курсору отдаёт тот же срез (стабильное чтение).
    const replay = await (
      await fetch(`${baseUrl}/mobile/v1/sync?device_id=device-1&cursor=${encodeURIComponent(baseline.cursor)}`)
    ).json();
    assert.deepEqual(
      replay.deltas.messages.map((m) => m.message_id).sort(),
      ["message-1", "message-2"],
    );
  });
});

describe("SVC-MOB BFF integration — idempotent send dedup (§11.12)", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createMobileApiServer({ mobileApi: createMobileBff({ now: incrementingClock() }) });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("accepts the first send and deduplicates the retry", async () => {
    const first = await postJson(baseUrl, "/mobile/v1/messages", sendMessageBody({ request_id: "req-1" }));
    const retry = await postJson(baseUrl, "/mobile/v1/messages", sendMessageBody({ request_id: "req-2" }));

    assert.equal(first.status, 202);
    assert.equal(first.body.duplicate, false);
    assert.equal(retry.status, 202);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.sequence_number, first.body.sequence_number, "no new sequence on retry");

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /mobile_api_messages_dedup_total 1/);
    assert.match(metrics, /mobile_api_messages_send_total 2/);
  });
});

describe("SVC-MOB BFF integration — push delivery via mock provider (§19.4)", () => {
  let server;
  let baseUrl;
  let bff;

  before(async () => {
    bff = createMobileBff({ now: incrementingClock() });
    server = createMobileApiServer({ mobileApi: bff });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("retransmits a C10 notification to FCM when there is no live WS (fallback)", async () => {
    // Устройство зарегистрировано, но офлайн → срабатывает fallback «нет WS → push».
    const register = await postJson(baseUrl, "/mobile/v1/devices", {
      contract: "MOBILE.RegisterDeviceRequest",
      version: "1.0.0",
      request_id: "req-device-1",
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "device-1",
      platform: "android",
      push_provider: "fcm",
      push_token: "fcm-token-1",
    });
    assert.equal(register.status, 201);

    const outcome = bff.handleRealtimeEvent({
      event: "notification.created",
      event_id: "evt-1",
      organization_id: "org-1",
      notification: {
        id: "notification-1",
        organization_id: "org-1",
        recipient_user_id: "manager-1",
        category: "critical",
        title: "Escalation",
        body: "A client is waiting",
        payload: { conversation_id: "conversation-1" },
        status: "new",
        created_at: "2026-07-04T12:00:00.000Z",
        read_at: null,
      },
    });

    assert.ok(outcome.pushed, "push dispatched through the mock provider");
    assert.equal(outcome.pushed.results[0].status, "delivered");
    assert.equal(bff.pushProvider.getMetrics().delivered_total, 1);

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /mobile_api_push_delivered_total 1/);
  });

  it("deactivates a dead push token reported by the provider", async () => {
    // BFF с инъектированным провайдером, который объявляет токен «мёртвым».
    const deadProvider = createMockPushProvider({
      now: incrementingClock(),
      deadTokens: ["apns-token-dead"],
    });
    const deadBff = createMobileBff({ now: incrementingClock(), pushProvider: deadProvider });
    deadBff.deviceRegistry.register({
      organizationId: "org-1",
      userId: "manager-1",
      deviceId: "device-dead",
      platform: "ios",
      pushProvider: "apns",
      pushToken: "apns-token-dead",
    });

    const outcome = deadBff.handleRealtimeEvent({
      event: "notification.created",
      event_id: "evt-dead",
      organization_id: "org-1",
      notification: {
        id: "notification-dead",
        organization_id: "org-1",
        recipient_user_id: "manager-1",
        category: "warning",
        title: "Reminder",
        body: "Please respond",
        payload: {},
        status: "new",
        created_at: "2026-07-04T12:00:00.000Z",
        read_at: null,
      },
    });

    assert.equal(outcome.pushed.results[0].status, "deactivated");
    assert.equal(outcome.pushed.results[0].reason, "token_unregistered");
    assert.equal(deadBff.deviceRegistry.get("device-dead").active, false);
    assert.equal(deadProvider.getMetrics().dead_token_total, 1);
  });
});

describe("SVC-MOB BFF integration — latency budgets (§25.2)", () => {
  let server;
  let baseUrl;

  before(async () => {
    const bff = createMobileBff({ now: incrementingClock() });
    // Наполняем реалистичный «экран»: 30 диалогов, история и лента уведомлений.
    for (let d = 0; d < 30; d += 1) {
      const conversationId = `conversation-${d}`;
      bff.backend.seedConversation({
        organizationId: "org-1",
        conversationId,
        clientId: `client-${d}`,
        displayName: `Client ${d}`,
      });
      for (let m = 0; m < 5; m += 1) {
        const messageId = `message-${d}-${m}`;
        bff.backend.sendMessage({
          organizationId: "org-1",
          conversationId,
          messageId,
          idempotencyKey: messageId,
          senderType: m % 2 === 0 ? "manager" : "client",
          text: `msg ${d}-${m}`,
        });
      }
    }
    for (let n = 0; n < 20; n += 1) {
      bff.backend.createNotification({
        organizationId: "org-1",
        notificationId: `notification-${n}`,
        recipientUserId: "manager-1",
        title: `Notification ${n}`,
        body: "body",
      });
    }
    server = createMobileApiServer({ mobileApi: bff });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  async function measure(path) {
    const start = performance.now();
    const response = await fetch(`${baseUrl}${path}`);
    await response.json();
    return { elapsed: performance.now() - start, status: response.status };
  }

  it("serves the dialog screen within the ≤1s budget", async () => {
    const { elapsed, status } = await measure("/mobile/v1/dialogs");
    assert.equal(status, 200);
    assert.ok(elapsed < LATENCY_BUDGET_MS.dialogs, `dialogs ${elapsed.toFixed(1)}ms < ${LATENCY_BUDGET_MS.dialogs}ms`);
  });

  it("serves message history within the ≤2s budget", async () => {
    const { elapsed, status } = await measure("/mobile/v1/dialogs/conversation-0/messages");
    assert.equal(status, 200);
    assert.ok(elapsed < LATENCY_BUDGET_MS.history, `history ${elapsed.toFixed(1)}ms < ${LATENCY_BUDGET_MS.history}ms`);
  });

  it("serves the notification feed within the ≤1s budget", async () => {
    const { elapsed, status } = await measure("/mobile/v1/notifications");
    assert.equal(status, 200);
    assert.ok(elapsed < LATENCY_BUDGET_MS.notifications, `notifications ${elapsed.toFixed(1)}ms < ${LATENCY_BUDGET_MS.notifications}ms`);
  });
});
