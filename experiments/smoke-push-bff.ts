/**
 * Smoke: push-цепочка (device-registry + provider + dispatcher), realtime
 * fallback и полный BFF (register → send/dedup → sync → dialogs → notifications).
 * Запуск: node experiments/smoke-push-bff.ts
 */
import assert from "node:assert/strict";

import { createMobileBff } from "../services/mobile-api/src/mobile-bff.js";
import { createMockBackendApi } from "../services/mobile-api/src/backend-client.js";
import { createDeviceRegistry } from "../services/mobile-api/src/device-registry.js";
import { createMockPushProvider } from "../services/mobile-api/src/push-provider.js";
import { createPushDispatcher } from "../services/mobile-api/src/push-dispatcher.js";

let tick = 0;
const now = () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;

// --- 1. Push dispatcher: ретраи при transient + деактивация dead-token ---
{
  const registry = createDeviceRegistry({ now });
  registry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "dev-live",
    platform: "ios",
    pushProvider: "apns",
    pushToken: "token-live",
  });
  registry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "dev-dead",
    platform: "android",
    pushProvider: "fcm",
    pushToken: "token-dead",
  });

  const provider = createMockPushProvider({
    deadTokens: ["token-dead"],
    transientTokens: ["token-live", "token-live"], // 2 временных отказа → потом успех
    now,
  });
  const dispatcher = createPushDispatcher({ provider, registry, maxAttempts: 3 });

  const notification = {
    notification_id: "n-1",
    organization_id: "org-1",
    user_id: "manager-1",
    title: "T",
    body: "B",
    severity: "critical",
    data: {},
    created_at: now(),
    read_at: null,
  };

  const outcome = dispatcher.dispatchToUser("manager-1", notification);
  const byDevice = Object.fromEntries(outcome.results.map((r) => [r.device_id, r]));

  assert.equal(byDevice["dev-live"].status, "delivered", "live доставлен после ретраев");
  assert.equal(byDevice["dev-live"].attempts, 3, "3 попытки: 2 transient + успех");
  assert.equal(byDevice["dev-dead"].status, "deactivated", "dead-token деактивирован");
  assert.equal(registry.get("dev-dead").active, false, "устройство помечено inactive");
  assert.equal(registry.get("dev-dead").deactivated_reason, "token_unregistered");
  // После деактивации dead уже не входит в активные.
  assert.deepEqual(
    registry.getActiveDevices("manager-1").map((d) => d.device_id),
    ["dev-live"],
    "деактивированное устройство исключено из активных",
  );
  console.log("[1] push dispatcher retries + dead-token deactivation: OK");
}

// --- 2. BFF: register → sendMessage (dedup) → sync (монотонность) ---
{
  const bff = createMobileBff({ now });

  const reg = bff.registerDevice({
    contract: "MOBILE.RegisterDeviceRequest",
    version: "1.0.0",
    request_id: "req-reg-1",
    organization_id: "org-1",
    user_id: "manager-1",
    device_id: "device-mobile-1",
    platform: "ios",
    push_provider: "apns",
    push_token: "apns-token-1",
  });
  assert.equal(reg.mock, false, "BFF помечает ответы mock:false");
  assert.equal(reg.device.active, true);
  assert.ok(reg.push_payload_stub.payload.token, "push stub содержит token");

  // seed диалога, чтобы sendMessage попало в существующий разговор
  bff.backend.seedConversation({
    organizationId: "org-1",
    conversationId: "conv-1",
    clientId: "client-1",
    displayName: "Ada",
  });

  const sendPayload = {
    contract: "MOBILE.SendMessageRequest",
    version: "1.0.0",
    request_id: "req-send-1",
    organization_id: "org-1",
    conversation_id: "conv-1",
    message_id: "msg-1",
    idempotency_key: "msg-1",
    sender_user_id: "manager-1",
    text: "hello",
  };
  const first = bff.sendMessage(sendPayload);
  assert.equal(first.duplicate, false, "первая отправка — не дубль");
  const second = bff.sendMessage({ ...sendPayload, request_id: "req-send-2" });
  assert.equal(second.duplicate, true, "повтор с тем же idempotency_key — дубль");
  assert.equal(first.sequence_number, second.sequence_number, "sequence не изменился при дубле");

  // sync: s0 → берём изменения, курсор двигается вперёд, повтор с s0 идемпотентен
  const s0 = bff.sync({});
  const c0 = s0.cursor;
  const s1 = bff.sync({ cursor: c0 });
  assert.equal(s1.deltas.messages.length, 0, "после применения — новых сообщений нет");
  const s0again = bff.sync({ cursor: s0.previous_cursor ?? undefined });
  assert.equal(
    s0again.deltas.messages.length,
    s0.deltas.messages.length,
    "повторный sync от исходного курсора отдаёт тот же срез (без потерь/дублей)",
  );

  const dialogs = bff.listDialogs();
  assert.equal(dialogs.items.length, 1, "один диалог");
  assert.equal(dialogs.items[0].last_message.text, "hello");

  console.log("[2] BFF register/send-dedup/sync/dialogs: OK");
}

// --- 3. Realtime fallback: нет онлайн-WS → push; есть онлайн → доставлено по WS ---
{
  const bff = createMobileBff({ now });
  bff.deviceRegistry.register({
    organizationId: "org-1",
    userId: "manager-1",
    deviceId: "device-mobile-1",
    platform: "ios",
    pushProvider: "apns",
    pushToken: "apns-token-1",
  });

  const notificationEvent = (id) => ({
    contract: "C7.NotificationCreatedEvent",
    version: "1.0.0",
    event: "notification.created",
    event_id: id,
    organization_id: "org-1",
    recipient_user_id: "manager-1",
    notification: {
      id: `notif-${id}`,
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "critical",
      title: "Alert",
      body: "Body",
      payload: {},
      status: "new",
      created_at: now(),
      read_at: null,
    },
    occurred_at: now(),
  });

  // устройство offline → push fallback
  const offlineResult = bff.handleRealtimeEvent(notificationEvent("evt-1"));
  assert.ok(offlineResult.pushed, "offline: push отправлен");
  assert.equal(offlineResult.pushed.results[0].status, "delivered");

  // помечаем online → WS-доставка, push не нужен
  bff.deviceRegistry.markOnline("device-mobile-1");
  const onlineResult = bff.handleRealtimeEvent(notificationEvent("evt-2"));
  assert.equal(onlineResult.pushed, null, "online: без push (доставлено по WS)");

  // дубль по event_id → без повторной обработки
  const dup = bff.handleRealtimeEvent(notificationEvent("evt-2"));
  assert.equal(dup.duplicate, true, "повтор event_id — дубль");

  const m = bff.realtimeConsumer.getMetrics();
  assert.equal(m.realtime_push_fallback_total, 1);
  assert.equal(m.realtime_ws_delivered_total, 1);
  assert.equal(m.realtime_duplicate_total, 1);

  console.log("[3] realtime fallback push/WS + dedup: OK");
}

console.log("\nALL SMOKE CHECKS PASSED");
