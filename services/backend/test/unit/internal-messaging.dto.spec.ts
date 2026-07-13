import { BadRequestException } from "@nestjs/common";

import {
  buildC2EgressDelivery,
  C2_DELIVERY_ATTEMPT_CONTRACT,
  C2_EGRESS_CONTRACT,
  C2_INGRESS_CONTRACT,
  C2_VERSION,
  isUuid,
  normalizeChannel,
  normalizeDeliveryAttempt,
  normalizeEgressRequest,
  normalizeIngressEnvelope,
  normalizeMessageType,
  uuidFromText,
  type IngressEnvelope,
} from "../../src/modules/communication-core/internal-messaging.dto";

const FIXED_NOW = "2026-07-04T10:00:00.000Z";
const now = (): string => FIXED_NOW;

const ORG_UUID = "30000000-0000-4000-8000-000000000101";
const MESSAGE_UUID = "30000000-0000-4000-8000-0000000009a1";

function validIngress(overrides: Partial<IngressEnvelope["message"]> = {}): IngressEnvelope {
  return {
    contract: C2_INGRESS_CONTRACT,
    version: C2_VERSION,
    idempotency_key: MESSAGE_UUID,
    message: {
      message_id: MESSAGE_UUID,
      organization_id: ORG_UUID,
      channel_id: "tg-bot-1",
      channel_type: "telegram",
      direction: "inbound",
      occurred_at: "2026-07-04T09:59:00.000Z",
      content: { type: "text", text: "привет" },
      ...overrides,
    },
  };
}

describe("internal-messaging.dto нормализация (issue #189, п. 1–3)", () => {
  describe("isUuid / uuidFromText", () => {
    it("распознаёт валидные UUID и отвергает мусор", () => {
      expect(isUuid(ORG_UUID)).toBe(true);
      expect(isUuid("не-uuid")).toBe(false);
      expect(isUuid(42)).toBe(false);
    });

    it("детерминированно выводит UUID v4 из строки", () => {
      const a = uuidFromText("mock:tenant-a");
      const b = uuidFromText("mock:tenant-a");
      expect(a).toBe(b);
      expect(isUuid(a)).toBe(true);
      expect(uuidFromText("mock:tenant-b")).not.toBe(a);
    });
  });

  describe("normalizeChannel / normalizeMessageType", () => {
    it("маппит mock→web_chat и voice→audio", () => {
      expect(normalizeChannel("mock")).toBe("web_chat");
      expect(normalizeChannel("telegram")).toBe("telegram");
      expect(normalizeMessageType("voice")).toBe("audio");
      expect(normalizeMessageType("text")).toBe("text");
    });

    it("отвергает неизвестные канал/тип", () => {
      expect(() => normalizeChannel("carrier-pigeon")).toThrow(BadRequestException);
      expect(() => normalizeMessageType("hologram")).toThrow(BadRequestException);
    });
  });

  describe("normalizeIngressEnvelope", () => {
    it("нормализует валидный конверт", () => {
      const result = normalizeIngressEnvelope(validIngress(), now);
      expect(result.organizationId).toBe(ORG_UUID);
      expect(result.message.id).toBe(MESSAGE_UUID);
      expect(result.channel).toBe("telegram");
      expect(result.message.type).toBe("text");
      expect(result.occurredAt).toBe("2026-07-04T09:59:00.000Z");
      expect(result.routedAt).toBe(FIXED_NOW);
      expect(result.idempotencyKey).toBe(MESSAGE_UUID);
    });

    it("выводит endpointExternalId из channel_id и sender_ref", () => {
      const result = normalizeIngressEnvelope(
        validIngress({ sender_ref: "user-42", conversation_ref: "conv-9" }),
        now,
      );
      expect(result.endpointExternalId).toBe("tg-bot-1:user-42");
      expect(result.senderRef).toBe("user-42");
      expect(result.conversationRef).toBe("conv-9");
    });

    it("падает на anonymous, когда нет sender_ref и conversation_ref", () => {
      const result = normalizeIngressEnvelope(validIngress(), now);
      expect(result.endpointExternalId).toBe("tg-bot-1:anonymous");
    });

    it("нормализует mock-канал и voice-тип", () => {
      const result = normalizeIngressEnvelope(
        validIngress({ channel_type: "mock", content: { type: "voice" } }),
        now,
      );
      expect(result.channel).toBe("web_chat");
      expect(result.message.type).toBe("audio");
      expect(result.message.content.type).toBe("audio");
    });

    it("проносит вложения из конверта для персистентности (§4.3)", () => {
      const result = normalizeIngressEnvelope(
        validIngress({
          attachments: [
            {
              id: "40000000-0000-4000-8000-0000000000a1",
              kind: "file",
              storage_ref: `edge-attach://${ORG_UUID}/${"a".repeat(64)}`,
              mime: "application/pdf",
              filename: "счёт.pdf",
              content_hash: "a".repeat(64),
              size: 2048,
            },
          ],
        } as never),
        now,
      );
      expect(result.message.attachments).toHaveLength(1);
      const [attachment] = result.message.attachments;
      expect(attachment.id).toBe("40000000-0000-4000-8000-0000000000a1");
      expect(attachment.storageRef).toBe(`edge-attach://${ORG_UUID}/${"a".repeat(64)}`);
      expect(attachment.mime).toBe("application/pdf");
      expect(attachment.size).toBe(2048);
      expect(attachment.metadata).toEqual({
        filename: "счёт.pdf",
        content_hash: "a".repeat(64),
      });
    });

    it("пропускает вложения без storage_ref (CHECK not-blank) и выводит UUID из не-UUID id", () => {
      const result = normalizeIngressEnvelope(
        validIngress({
          attachments: [
            { id: "no-ref", kind: "file", mime: "text/plain" },
            { id: "legacy-id", kind: "file", storage_ref: "edge-attach://x/y", mime: "text/plain" },
          ],
        } as never),
        now,
      );
      expect(result.message.attachments).toHaveLength(1);
      expect(isUuid(result.message.attachments[0].id)).toBe(true);
    });

    it("даёт пустой список вложений, когда их нет", () => {
      const result = normalizeIngressEnvelope(validIngress(), now);
      expect(result.message.attachments).toEqual([]);
    });

    it("отклоняет неверную версию контракта", () => {
      expect(() =>
        normalizeIngressEnvelope({ ...validIngress(), version: "0.9.0" }, now),
      ).toThrow(BadRequestException);
    });

    it("отклоняет несовпадение idempotency_key и message_id", () => {
      const envelope = validIngress();
      envelope.idempotency_key = "30000000-0000-4000-8000-0000000009ff";
      expect(() => normalizeIngressEnvelope(envelope, now)).toThrow(BadRequestException);
    });

    it("отклоняет направление, отличное от inbound", () => {
      expect(() =>
        normalizeIngressEnvelope(validIngress({ direction: "outbound" }), now),
      ).toThrow(BadRequestException);
    });

    it("отклоняет отсутствие content-объекта", () => {
      expect(() =>
        normalizeIngressEnvelope(validIngress({ content: "текст" }), now),
      ).toThrow(BadRequestException);
    });
  });

  describe("normalizeEgressRequest", () => {
    it("нормализует валидный запрос с дефолтным адаптером", () => {
      const result = normalizeEgressRequest({
        organization_id: ORG_UUID,
        message_id: MESSAGE_UUID,
      });
      expect(result.organizationId).toBe(ORG_UUID);
      expect(result.messageId).toBe(MESSAGE_UUID);
      expect(result.adapter).toBe("mock");
      expect(result.adapterEndpointId).toBeNull();
    });

    it("сохраняет явный адаптер и endpoint", () => {
      const result = normalizeEgressRequest({
        organization_id: ORG_UUID,
        message_id: MESSAGE_UUID,
        adapter: "telegram",
        adapter_endpoint_id: "endpoint-1",
      });
      expect(result.adapter).toBe("telegram");
      expect(result.adapterEndpointId).toBe("endpoint-1");
    });

    it("отклоняет не-UUID организацию/сообщение", () => {
      expect(() =>
        normalizeEgressRequest({ organization_id: "x", message_id: MESSAGE_UUID }),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeEgressRequest({ organization_id: ORG_UUID, message_id: "y" }),
      ).toThrow(BadRequestException);
    });
  });

  describe("normalizeDeliveryAttempt", () => {
    it("нормализует валидную попытку доставки", () => {
      const result = normalizeDeliveryAttempt(
        {
          contract: C2_DELIVERY_ATTEMPT_CONTRACT,
          organization_id: ORG_UUID,
          message_id: MESSAGE_UUID,
          adapter: "telegram",
          attempt_no: 1,
          status: "delivered",
        },
        now,
      );
      expect(result.status).toBe("delivered");
      expect(result.attemptNo).toBe(1);
      expect(result.error).toBeNull();
      expect(result.occurredAt).toBe(FIXED_NOW);
    });

    it("отклоняет неизвестный статус и неположительный attempt_no", () => {
      expect(() =>
        normalizeDeliveryAttempt(
          { organization_id: ORG_UUID, message_id: MESSAGE_UUID, adapter: "tg", attempt_no: 1, status: "bogus" },
          now,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeDeliveryAttempt(
          { organization_id: ORG_UUID, message_id: MESSAGE_UUID, adapter: "tg", attempt_no: 0, status: "sent" },
          now,
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe("buildC2EgressDelivery", () => {
    it("строит конверт C2.EgressDelivery из сообщения и endpoint-а", () => {
      const delivery = buildC2EgressDelivery(
        {
          id: MESSAGE_UUID,
          organization_id: ORG_UUID,
          conversation_id: "conv-77",
          channel: "telegram",
          type: "text",
          content: { text: "ответ" },
        },
        {
          channel: "telegram",
          external_id: "tg-bot-1:user-42",
          metadata: { channel_id: "12345", conversation_ref: "chat-9" },
        },
      );
      expect(delivery.contract).toBe(C2_EGRESS_CONTRACT);
      expect(delivery.version).toBe(C2_VERSION);
      expect(delivery.idempotency_key).toBe(MESSAGE_UUID);
      expect(delivery.channel_id).toBe("12345");
      expect(delivery.message.conversation_ref).toBe("chat-9");
      expect(delivery.message.direction).toBe("outbound");
      expect(delivery.message.content).toMatchObject({ text: "ответ", type: "text" });
    });

    it("использует external_id и conversation_id при отсутствии метаданных", () => {
      const delivery = buildC2EgressDelivery(
        {
          id: MESSAGE_UUID,
          organization_id: ORG_UUID,
          conversation_id: "conv-77",
          channel: "web_chat",
          type: "text",
          content: {},
        },
        { channel: "web_chat", external_id: "web:anon", metadata: null },
      );
      expect(delivery.channel_id).toBe("web:anon");
      expect(delivery.message.conversation_ref).toBe("conv-77");
    });

    it("прокидывает исходящие вложения (storage_ref) в конверт egress", () => {
      const storageRef = `edge-attach://${ORG_UUID}/${"a".repeat(64)}`;
      const delivery = buildC2EgressDelivery(
        {
          id: MESSAGE_UUID,
          organization_id: ORG_UUID,
          conversation_id: "conv-77",
          channel: "email",
          type: "text",
          content: { text: "во вложении" },
        },
        {
          channel: "email",
          external_id: "email-chan:client@example.com",
          metadata: { channel_id: "email-chan", sender_ref: "client@example.com" },
        },
        [{ storage_ref: storageRef, filename: "отчёт.pdf", mime: "application/pdf", size: 2048 }],
      );
      expect(delivery.message.attachments).toEqual([
        { storage_ref: storageRef, filename: "отчёт.pdf", mime: "application/pdf", size: 2048 },
      ]);
      // Адресация письма — реальный email клиента (не UUID диалога).
      expect(delivery.message.recipient_ref).toBe("client@example.com");
    });

    it("не добавляет attachments, когда их нет (обратная совместимость)", () => {
      const delivery = buildC2EgressDelivery(
        {
          id: MESSAGE_UUID,
          organization_id: ORG_UUID,
          conversation_id: "conv-77",
          channel: "email",
          type: "text",
          content: { text: "без вложений" },
        },
        { channel: "email", external_id: "email-chan:client@example.com", metadata: null },
      );
      expect(delivery.message.attachments).toBeUndefined();
    });
  });
});
