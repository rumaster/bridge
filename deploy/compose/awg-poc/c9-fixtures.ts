// Общая фикстура канонического C9-сообщения для PoC Этапа 0 (issue #257).
// Строит валидный EdgeTunnelMessage; размер регулируется длиной content.text,
// чтобы прогнать «кадр по верхней границе 2 МБ» через туннель (Q8).
import { createEdgeTunnelMessage } from "../../../packages/contracts/src/c9.js";

const BASE_MESSAGE = Object.freeze({
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  conversation_id: "32345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  channel: "telegram",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 1,
  type: "text",
  status: "received",
  created_at: "2026-07-02T16:10:00.000Z",
  updated_at: "2026-07-02T16:10:00.000Z",
});

export function buildTunnelMessage({
  sequenceNumber = 1,
  contentBytes = 0,
}: { sequenceNumber?: number; contentBytes?: number } = {}) {
  const text = contentBytes > 0 ? "x".repeat(contentBytes) : "ping";
  const payload = {
    ...BASE_MESSAGE,
    sequence_number: sequenceNumber,
    content: { text },
  };
  return createEdgeTunnelMessage({
    payload,
    receivedAt: "2026-07-02T16:10:01.000Z",
    bufferedAt: "2026-07-02T16:10:02.000Z",
    forwardedAt: "2026-07-02T16:10:03.000Z",
  });
}
