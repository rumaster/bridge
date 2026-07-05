/**
 * Smoke: HTTP-сервер поверх реального BFF (mode "bff"). Проверяет health.mode,
 * /metrics (семейство mobile_api_*), агрегированные /dialogs и идемпотентный send.
 * Запуск: node experiments/smoke-bff-server.ts
 */
import assert from "node:assert/strict";

import { createMobileBff } from "../services/mobile-api/src/mobile-bff.js";
import { createMobileApiServer } from "../services/mobile-api/src/server.js";

let tick = 0;
const now = () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;

const bff = createMobileBff({ now });
bff.backend.seedClient({ organizationId: "org-1", clientId: "client-1", displayName: "Ada" });
bff.backend.seedConversation({
  organizationId: "org-1",
  conversationId: "conversation-1",
  clientId: "client-1",
  displayName: "Ada",
});
bff.backend.sendMessage({
  organizationId: "org-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  idempotencyKey: "message-1",
  senderType: "client",
  text: "hi",
});

const server = createMobileApiServer({ mobileApi: bff, now });
const baseUrl = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(`http://${address.address}:${address.port}`);
  });
});

try {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.mode, "bff", "health.mode = bff");
  assert.equal(health.contract, "MOBILE.v1");

  const dialogs = await (await fetch(`${baseUrl}/mobile/v1/dialogs`)).json();
  assert.equal(dialogs.mock, false, "BFF ответы mock:false");
  assert.equal(dialogs.items.length, 1);
  assert.equal(dialogs.items[0].last_message.text, "hi");
  assert.equal(dialogs.items[0].unread_count, 1, "непрочитанное клиентское сообщение");

  const metricsText = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(metricsText, /mobile_api_dialogs_list_total 1/);
  assert.match(metricsText, /mobile_api_messages_dedup_total 0/);
  assert.ok(!metricsText.includes("mobile_api_mock_"), "старое семейство mock_ убрано");

  // идемпотентный POST /messages (202) + повтор — дубль
  const sendBody = {
    contract: "MOBILE.SendMessageRequest",
    version: "1.0.0",
    request_id: "req-1",
    organization_id: "org-1",
    conversation_id: "conversation-1",
    message_id: "message-9",
    idempotency_key: "message-9",
    sender_user_id: "manager-1",
    text: "reply",
  };
  const first = await fetch(`${baseUrl}/mobile/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sendBody),
  });
  assert.equal(first.status, 202);
  const firstJson = await first.json();
  assert.equal(firstJson.duplicate, false);

  const second = await fetch(`${baseUrl}/mobile/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sendBody, request_id: "req-2" }),
  });
  const secondJson = await second.json();
  assert.equal(secondJson.duplicate, true, "повтор idempotency_key → duplicate:true");

  console.log("BFF server smoke: OK (health.mode=bff, mock:false, dedup, metrics)");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
