import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNotificationTriggerEvent } from "../../packages/contracts/src/c10.js";
import { createDeterministicBroadcastMock } from "../../services/broadcast-platform/src/deterministic-broadcast.js";
import { startBroadcastPlatformGrpcServer } from "../../services/broadcast-platform/src/grpc-server.js";
import { BroadcastGrpcUpstreamClient } from "../../services/backend/src/modules/broadcast-facade/broadcast-grpc-upstream.client.js";
import { createDeterministicNotificationMock } from "../../services/notification-platform/src/deterministic-notification.js";
import { startNotificationPlatformGrpcServer } from "../../services/notification-platform/src/grpc-server.js";
import { createNotificationTriggerStreamConsumer } from "../../services/notification-platform/src/notification-trigger-stream.js";
import { NotificationGrpcUpstreamClient } from "../../services/backend/src/modules/notification-facade/notification-grpc-upstream.client.js";

const fixedNow = () => "2026-07-07T02:40:00.000Z";

describe("Stage 7 MP-03/MP-04/MP-09/MP-10 C8/C10 real internal transports", () => {
  it("routes Backend C8/C10 facade clients over internal gRPC contracts", async () => {
    const broadcastHandle = await startBroadcastPlatformGrpcServer({
      broadcast: createDeterministicBroadcastMock({ now: fixedNow }),
      host: "127.0.0.1",
      port: 0,
    });
    const notificationHandle = await startNotificationPlatformGrpcServer({
      host: "127.0.0.1",
      notifications: createDeterministicNotificationMock({ now: fixedNow }),
      port: 0,
    });
    const broadcastClient = new BroadcastGrpcUpstreamClient({
      target: `127.0.0.1:${broadcastHandle.port}`,
    });
    const notificationClient = new NotificationGrpcUpstreamClient({
      target: `127.0.0.1:${notificationHandle.port}`,
    });

    try {
      assert.equal((await broadcastClient.getHealth()).mode, "grpc");
      assert.equal((await notificationClient.getHealth()).mode, "grpc");

      const created = await broadcastClient.createBroadcast({
        created_by: "manager-stage-7",
        filter: { mode: "all", channels: ["web_chat"], tags: [], segment_ids: [], criteria: {} },
        name: "Stage 7 campaign",
        organization_id: "org-stage-7",
        rate_limit: { messages_per_minute: 120, strategy: "fixed" },
        request_id: "req-stage-7-broadcast-create",
        schedule: { mode: "manual" },
        template: { type: "text", body: "Здравствуйте, {{client.name}}", variables: ["client.name"] },
      });
      assert.equal(created.contract, "C8.CreateBroadcastResponse");
      assert.equal(created.degraded, undefined);

      const started = await broadcastClient.startBroadcast({
        broadcast_id: created.broadcast.id,
        mode: "immediate",
        organization_id: "org-stage-7",
        request_id: "req-stage-7-broadcast-start",
        started_by: "manager-stage-7",
      });
      assert.equal(started.contract, "C8.StartBroadcastResponse");
      assert.equal(started.degraded, false);
      assert.equal(started.broadcast.status, "done");

      const stats = await broadcastClient.getBroadcastStats({
        broadcast_id: created.broadcast.id,
        organization_id: "org-stage-7",
        request_id: "req-stage-7-broadcast-stats",
      });
      assert.equal(stats.contract, "C8.BroadcastStatsResponse");
      assert.equal(stats.stats.sent, 3);

      const notificationList = await notificationClient.listNotifications({
        organization_id: "org-1",
        request_id: "req-stage-7-notifications-list",
        user_id: "manager-1",
      });
      assert.equal(notificationList.contract, "C10.ListNotificationsResponse");
      assert.equal(notificationList.items.length, 1);

      const read = await notificationClient.markNotificationRead({
        notification_id: notificationList.items[0].id,
        organization_id: "org-1",
        request_id: "req-stage-7-notification-read",
        user_id: "manager-1",
      });
      assert.equal(read.contract, "C10.MarkNotificationReadResponse");
      assert.equal(read.notification.status, "read");

      const health = await notificationClient.getHealth();
      assert.equal(health.status, "ok");
      assert.equal(health.mode, "grpc");
    } finally {
      broadcastClient.onModuleDestroy();
      notificationClient.onModuleDestroy();
      await shutdownGrpcServer(broadcastHandle.server);
      await shutdownGrpcServer(notificationHandle.server);
    }
  });

  it("consumes C10 notification triggers from a Redis Stream consumer group", async () => {
    const trigger = createNotificationTriggerEvent({
      body: "Client sent a priority message.",
      category: "critical",
      dedupeKey: "SVC-CORE:message-stage-7:manager-1",
      eventId: "message-stage-7:notif",
      occurredAt: fixedNow(),
      organizationId: "org-1",
      payload: { message_id: "message-stage-7" },
      producerEventId: "message-stage-7:created",
      producerServiceId: "SVC-CORE",
      recipientUserId: "manager-1",
      title: "New priority message",
    });
    const redis = new ScriptedRedisStreamClient({
      "1700000000000-0": { payload: JSON.stringify(trigger) },
    });
    const notifications = createDeterministicNotificationMock({ now: fixedNow });
    const consumer = createNotificationTriggerStreamConsumer({
      consumer: "stage7-test",
      group: "svc-notif",
      notifications,
      redis,
      stream: "bridge:notifications:trigger",
    });

    await consumer.ensureConsumerGroup();
    const consumed = await consumer.pollOnce();

    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].response.contract, "C10.AcceptNotificationTriggerResponse");
    assert.equal(consumed[0].response.duplicate, false);
    assert.deepEqual(redis.ackedIds, ["1700000000000-0"]);

    const list = notifications.listNotifications(
      { organizationId: "org-1", requestId: "req-stage-7-list-critical", userId: "manager-1" },
      { category: "critical" },
    );
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].dedupe_key, trigger.dedupe_key);
  });
});

function shutdownGrpcServer(server: { tryShutdown(callback: () => void): void }) {
  return new Promise<void>((resolveShutdown) => {
    server.tryShutdown(() => resolveShutdown());
  });
}

class ScriptedRedisStreamClient {
  readonly ackedIds: string[] = [];
  private delivered = false;

  constructor(private readonly messages: Record<string, Record<string, string>>) {}

  async sendCommand(args: string[]) {
    if (args[0] === "XGROUP") {
      return "OK";
    }
    if (args[0] === "XREADGROUP") {
      if (this.delivered) {
        return [];
      }
      this.delivered = true;
      return [
        [
          args[args.indexOf("STREAMS") + 1],
          Object.entries(this.messages).map(([id, fields]) => [
            id,
            Object.entries(fields).flat(),
          ]),
        ],
      ];
    }
    if (args[0] === "XACK") {
      this.ackedIds.push(...args.slice(3));
      return args.length - 3;
    }
    throw new Error(`Unexpected Redis command: ${args.join(" ")}`);
  }
}
