import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWebSocketEvent } from "../../../../packages/contracts/src/c7.js";
import { createC7RedisStreamBridge } from "../../src/c7-redis-stream-bridge.js";
import { createMockWebSocketChannel } from "../../src/mock-ws-channel.js";

describe("C7 Redis Stream bridge", () => {
  it("читает C7-события из Redis Streams и доставляет их WS-подписчикам", async () => {
    const wsChannel = createMockWebSocketChannel();
    const delivered = [];
    const event = createWebSocketEvent({
      event: "message.created",
      eventId: "event-redis-1",
      organizationId: "org-1",
      payload: {
        message: {
          conversation_id: "conversation-1",
          id: "message-1",
        },
      },
      sequenceNumber: 1,
      occurredAt: "2026-07-07T08:00:00.000Z",
    });
    const streamClient = {
      acked: [],
      async ensureConsumerGroup() {},
      async readGroup() {
        return [
          [
            "bridge:c7:events",
            [["1680000000000-0", ["event", JSON.stringify(event), "type", "message.created"]]],
          ],
        ];
      },
      async ack(_stream, _group, id) {
        this.acked.push(id);
      },
      async close() {},
    };
    const bridge = createC7RedisStreamBridge({
      streamClient,
      wsChannel,
      pollMs: 1,
    });

    wsChannel.connect({
      subscription: {
        organizationId: "org-1",
        conversationId: "conversation-1",
      },
      send(deliveredEvent) {
        delivered.push(deliveredEvent.event_id);
      },
    });

    await bridge.pollOnce();

    assert.deepEqual(delivered, ["event-redis-1"]);
    assert.deepEqual(streamClient.acked, ["1680000000000-0"]);
  });

  // Регрессия W7: боевой node-redis (`redis` ^6, RESP3) возвращает XREADGROUP как
  // ОБЪЕКТ `{ [stream]: entries }`, а не массив. Раньше парсер это не понимал —
  // события не доходили до WS. Проверяем оба вида записей (массив полей и объект).
  const builders: Array<[string, (eventJson: string) => unknown]> = [
    [
      "object map + array entry (поля массивом)",
      (eventJson) => ({
        "bridge:c7:events": [
          ["1680000000001-0", ["event", eventJson, "type", "message.created"]],
        ],
      }),
    ],
    [
      "object map + object entry (node-redis v4 {id,message})",
      (eventJson) => ({
        "bridge:c7:events": [
          { id: "1680000000001-0", message: { event: eventJson, type: "message.created" } },
        ],
      }),
    ],
  ];

  for (const [label, build] of builders) {
    it(`доставляет события из формата ответа node-redis: ${label}`, async () => {
      const wsChannel = createMockWebSocketChannel();
      const delivered: string[] = [];
      const event = createWebSocketEvent({
        event: "message.created",
        eventId: "event-obj-1",
        organizationId: "org-1",
        payload: { message: { conversation_id: "conversation-1", id: "m-1" } },
        sequenceNumber: 1,
        occurredAt: "2026-07-07T08:00:00.000Z",
      });
      const result = build(JSON.stringify(event));
      const acked: string[] = [];
      const streamClient = {
        async ensureConsumerGroup() {},
        async readGroup() {
          return result;
        },
        async ack(_s: string, _g: string, id: string) {
          acked.push(id);
        },
        async close() {},
      };
      const bridge = createC7RedisStreamBridge({ streamClient, wsChannel, pollMs: 1 });
      wsChannel.connect({
        subscription: { organizationId: "org-1", conversationId: "conversation-1" },
        send(e: { event_id: string }) {
          delivered.push(e.event_id);
        },
      });

      await bridge.pollOnce();

      assert.deepEqual(delivered, ["event-obj-1"]);
      assert.deepEqual(acked, ["1680000000001-0"]);
    });
  }
});
