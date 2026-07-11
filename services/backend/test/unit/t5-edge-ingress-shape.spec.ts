import {
  normalizeIngressEnvelope,
  uuidFromText,
} from "../../src/modules/communication-core/internal-messaging.dto";
import { normalizeEdgeTunnelMessage } from "../../src/modules/communication-core/communication-core-m4.dto";

/**
 * T5 (docs/plan/telegram-channel-production.md): проверка совместимости проводных
 * форматов, которые SVC-INT (integration-platform) формирует для приёма Telegram —
 * прямого (C2 → CORE_INGRESS_URL) и edge (C2 → Edge → C9 tunnel → acceptIngress).
 *
 * Тест чисто-функциональный (без БД/Docker): гоняет ровно те конверты через
 * реальные нормализаторы ядра. Он же — регрессионный страж бага T3, когда
 * `message_id = tg-<channel>-<update_id>` (не UUID) молча отвергался ядром
 * (в T3-тестах backend был замокан). SVC-INT `uuidFromText` копирует этот же
 * алгоритм, поэтому идентификаторы здесь совпадают с продовыми.
 */

const now = () => "2026-07-10T00:00:00.000Z";
const ORG = "11111111-1111-4111-8111-111111111111";
const CHAN = "tg-bot-channel-a";

// Совпадает с SVC-INT stableTelegramMessageId / stableEdgeEndpointId.
const MESSAGE_ID = uuidFromText(`tg-message:${CHAN}:10`);
const ENDPOINT_ID = uuidFromText(`tg-endpoint:${CHAN}:client-1`);

function c2Ingress(): Record<string, unknown> {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: MESSAGE_ID,
    received_at: now(),
    message: {
      message_id: MESSAGE_ID,
      idempotency_key: MESSAGE_ID,
      organization_id: ORG,
      channel_id: CHAN,
      channel_type: "telegram",
      conversation_ref: "chat-1",
      sender_ref: "client-1",
      direction: "inbound",
      content: { type: "text", text: "Здравствуйте" },
      occurred_at: now(),
    },
  };
}

describe("T5 ingress wire compatibility (SVC-INT → CORE)", () => {
  it("accepts the direct C2 ingress SVC-INT produces with a UUID message id", () => {
    const normalized = normalizeIngressEnvelope(c2Ingress() as never, now);

    expect(normalized.message.id).toBe(MESSAGE_ID);
    expect(normalized.organizationId).toBe(ORG);
    expect(normalized.channel).toBe("telegram");
    expect(normalized.senderRef).toBe("client-1");
    expect(normalized.conversationRef).toBe("chat-1");
  });

  it("rejects the legacy non-UUID tg-<id> message id (why T5/T3 switched to a UUID)", () => {
    const legacy = c2Ingress();
    legacy.idempotency_key = "tg-chan-A-10";
    (legacy.message as Record<string, unknown>).message_id = "tg-chan-A-10";
    (legacy.message as Record<string, unknown>).idempotency_key = "tg-chan-A-10";

    expect(() => normalizeIngressEnvelope(legacy as never, now)).toThrow();
  });

  it("accepts the edge-tunnelled C2 ingress end to end (Edge cluster → C9 tunnel → acceptIngress)", () => {
    // 1) SVC-INT edge-ingest body = конверт C2 + поля верхнего уровня для Edge.
    const edgeBody: Record<string, unknown> = {
      ...c2Ingress(),
      id: MESSAGE_ID,
      idempotency_key: MESSAGE_ID,
      endpoint_id: ENDPOINT_ID,
    };

    // 2) Edge Cluster назначает sequence_number и пересылает {...body, sequence_number}
    //    как payload в C9.EdgeTunnelMessage (endpoint_id/sequence_number/idempotency_key
    //    берутся из payload — см. createEdgeTunnelMessage).
    const payload: Record<string, unknown> = { ...edgeBody, sequence_number: 1 };
    const tunnelMessage = {
      contract: "C9.EdgeTunnelMessage",
      version: "1.0.0",
      endpoint_id: payload.endpoint_id,
      sequence_number: payload.sequence_number,
      idempotency_key: payload.idempotency_key,
      payload,
      timestamps: { received_at: now(), buffered_at: now(), forwarded_at: now() },
    };

    // 3) Backend edge-tunnel приёмник нормализует конверт C9...
    const normalizedTunnel = normalizeEdgeTunnelMessage(tunnelMessage as never, now);
    expect(normalizedTunnel.endpoint_id).toBe(ENDPOINT_ID);
    expect(normalizedTunnel.sequence_number).toBe(1);

    // 4) ...и EdgeIntakeCoordinatorService отдаёт payload в acceptIngress → normalize.
    const normalized = normalizeIngressEnvelope(normalizedTunnel.payload as never, now);
    expect(normalized.message.id).toBe(MESSAGE_ID);
    expect(normalized.organizationId).toBe(ORG);
    expect(normalized.channel).toBe("telegram");
    expect(normalized.conversationRef).toBe("chat-1");
  });
});
