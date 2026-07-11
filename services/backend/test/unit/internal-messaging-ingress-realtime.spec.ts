import { InternalMessagingService } from "../../src/modules/communication-core/internal-messaging.service";

/**
 * G-7 (Этап T4): acceptIngress публикует C7 `message.created` на приёме входящего,
 * чтобы менеджер видел сообщение клиента в реальном времени. Публикация — только
 * для не-дубликата и best-effort (сбой realtime не ломает приём).
 *
 * Тест изолирует именно решение о публикации: `database.withTenant` застаблен
 * готовым результатом acceptIngress (insert/идемпотентность покрыты интеграционным
 * Testcontainers-спеком internal-messaging.spec.ts).
 */

const ORG = "20000000-0000-4000-8000-000000000101";
const MSG = "20000000-0000-4000-8000-000000000601";

function ingressEnvelope(): Record<string, unknown> {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: MSG,
    message: {
      message_id: MSG,
      organization_id: ORG,
      channel_id: "tg-bot-1",
      channel_type: "telegram",
      sender_ref: "tg-user-42",
      conversation_ref: "chat-1",
      direction: "inbound",
      occurred_at: "2026-07-04T09:00:00.000Z",
      content: { type: "text", text: "Здравствуйте!" },
    },
  };
}

function acceptResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accepted: true,
    duplicate: false,
    message_id: MSG,
    idempotency_key: MSG,
    organization_id: ORG,
    client_id: "10000000-0000-4000-8000-0000000000c1",
    conversation_id: "10000000-0000-4000-8000-0000000000c2",
    endpoint_id: "10000000-0000-4000-8000-0000000000e1",
    sequence_number: 5,
    status: "routed",
    routed_to: "manager",
    received_at: "2026-07-04T09:00:00.000Z",
    routed_at: "2026-07-04T09:00:00.000Z",
    ...overrides,
  };
}

function buildService(result: Record<string, unknown>) {
  const publishMessageCreated = jest.fn(async () => {});
  const realtime = {
    publishMessageCreated,
    publishMessageStatusChanged: jest.fn(async () => {}),
  };
  const loadProbe = {
    startTimer: () => () => 0,
    recordIngress: jest.fn(),
    recordIngressFailure: jest.fn(),
  };
  const database = {
    withTenant: jest.fn(async () => result),
  };
  const audit = { record: jest.fn() };
  const adapterFailures = { deliver: jest.fn() };

  const service = new InternalMessagingService(
    database as never,
    audit as never,
    adapterFailures as never,
    loadProbe as never,
    realtime as never,
  );

  return { service, publishMessageCreated };
}

describe("InternalMessagingService acceptIngress → C7 realtime (T4/G-7)", () => {
  it("публикует message.created для нового входящего с корректным конвертом", async () => {
    const { service, publishMessageCreated } = buildService(acceptResult());

    const result = await service.acceptIngress(ingressEnvelope());

    expect(result.duplicate).toBe(false);
    expect(publishMessageCreated).toHaveBeenCalledTimes(1);
    expect(publishMessageCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MSG,
        organizationId: ORG,
        conversationId: "10000000-0000-4000-8000-0000000000c2",
        endpointId: "10000000-0000-4000-8000-0000000000e1",
        channel: "telegram",
        direction: "inbound",
        senderType: "client",
        sequenceNumber: 5,
        type: "text",
        content: expect.objectContaining({ text: "Здравствуйте!" }),
        status: "routed",
        createdAt: "2026-07-04T09:00:00.000Z",
        deliveredAt: null,
      }),
    );
  });

  it("НЕ публикует повторное realtime-событие для дубликата входящего", async () => {
    const { service, publishMessageCreated } = buildService(acceptResult({ duplicate: true }));

    const result = await service.acceptIngress(ingressEnvelope());

    expect(result.duplicate).toBe(true);
    expect(publishMessageCreated).not.toHaveBeenCalled();
  });

  it("не роняет приём, если публикация realtime упала (best-effort)", async () => {
    const { service, publishMessageCreated } = buildService(acceptResult());
    publishMessageCreated.mockRejectedValueOnce(new Error("redis down"));

    const result = await service.acceptIngress(ingressEnvelope());

    expect(result).toMatchObject({ accepted: true, duplicate: false, message_id: MSG });
    expect(publishMessageCreated).toHaveBeenCalledTimes(1);
  });
});
