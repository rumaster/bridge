import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNotification,
  createNotificationCreatedEvent,
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
  validateNotificationTriggerEvent,
} from "../../src/c10.mjs";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("C10 notification event schemas", () => {
  it("accepts the frozen notification.created C7 event", () => {
    const notification = createNotification({
      notificationId: "notification-1",
      organizationId: "org-1",
      recipientUserId: "manager-1",
      category: "warning",
      title: "Campaign requires attention",
      body: "Broadcast campaign campaign-1 has a warning.",
      channels: ["web", "telegram"],
      createdAt: fixedNow(),
    });

    const event = createNotificationCreatedEvent({
      eventId: "notification-1:created",
      notification,
      occurredAt: fixedNow(),
    });

    const result = validateNotificationCreatedEvent(event);

    assert.equal(result.valid, true);
    assert.equal(event.event, "notification.created");
  });

  it("rejects notification.created events with unsupported categories", () => {
    const notification = createNotification({
      notificationId: "notification-1",
      organizationId: "org-1",
      recipientUserId: "manager-1",
      category: "info",
      title: "New notification",
      channels: ["web"],
      createdAt: fixedNow(),
    });

    const result = validateNotificationCreatedEvent(
      createNotificationCreatedEvent({
        eventId: "notification-1:created",
        notification: {
          ...notification,
          category: "marketing",
        },
        occurredAt: fixedNow(),
      }),
    );

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /notification\.category/);
  });

  it("accepts the producer -> notification trigger event stub", () => {
    const event = createNotificationTriggerEvent({
      eventId: "producer-event-1:notif",
      producerServiceId: "SVC-FBP",
      producerEventId: "workflow-instance-1:completed",
      organizationId: "org-1",
      recipientUserId: "manager-1",
      category: "info",
      title: "Workflow completed",
      body: "Workflow workflow-1 has completed.",
      payload: {
        workflow_id: "workflow-1",
      },
      dedupeKey: "SVC-FBP:workflow-instance-1:completed:manager-1",
      occurredAt: fixedNow(),
    });

    const result = validateNotificationTriggerEvent(event);

    assert.equal(result.valid, true);
    assert.equal(event.event, "notification.triggered");
  });
});
