import { C7RealtimeEventPublisher } from "../../src/modules/communication-core/c7-realtime-event.publisher";

describe("C7RealtimeEventPublisher", () => {
  it("публикует message.created в Redis Stream как C7.WebSocketEvent", async () => {
    const publishStream = jest.fn<Promise<string>, [string, Record<string, string>]>(
      async () => "1680000000000-0",
    );
    const redis = {
      isConfigured: jest.fn(() => true),
      publishStream,
    };
    const publisher = new C7RealtimeEventPublisher(redis as never);

    await publisher.publishMessageCreated({
      channel: "web_chat",
      content: { text: "Ответ менеджера" },
      conversationId: "32345678-1234-4234-8234-123456789abc",
      createdAt: "2026-07-07T08:00:00.000Z",
      deliveredAt: null,
      direction: "outbound",
      endpointId: "42345678-1234-4234-8234-123456789abc",
      id: "52345678-1234-4234-8234-123456789abc",
      organizationId: "22345678-1234-4234-8234-123456789abc",
      senderType: "manager",
      sequenceNumber: 7,
      status: "routed",
      type: "text",
    });

    expect(redis.publishStream).toHaveBeenCalledTimes(1);
    expect(redis.publishStream).toHaveBeenCalledWith(
      "bridge:c7:events",
      expect.objectContaining({
        event: expect.any(String),
        type: "message.created",
      }),
    );
    const publishedFields = redis.publishStream.mock.calls[0]?.[1] as
      | { event: string }
      | undefined;
    expect(publishedFields).toBeDefined();
    const event = JSON.parse(publishedFields?.event ?? "{}");
    expect(event).toMatchObject({
      contract: "C7.WebSocketEvent",
      event: "message.created",
      event_id: "message.created:52345678-1234-4234-8234-123456789abc",
      organization_id: "22345678-1234-4234-8234-123456789abc",
      sequence_number: 7,
      payload: {
        message: {
          id: "52345678-1234-4234-8234-123456789abc",
          channel: "web_chat",
          senderType: "manager",
        },
      },
    });
  });

  it("не требует Redis в dev/test окружении без REDIS_URL", async () => {
    const redis = {
      isConfigured: jest.fn(() => false),
      publishStream: jest.fn(),
    };
    const publisher = new C7RealtimeEventPublisher(redis as never);

    await publisher.publishMessageStatusChanged({
      eventId: "status:event",
      messageId: "message-1",
      organizationId: "org-1",
      sequenceNumber: 1,
      status: "delivered",
    });

    expect(redis.publishStream).not.toHaveBeenCalled();
  });
});
