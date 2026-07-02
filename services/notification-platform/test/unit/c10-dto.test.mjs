import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNotificationTriggerEvent } from "../../../../packages/contracts/src/c10.mjs";
import {
  validateListNotificationsQuery,
  validateNotificationTriggerEventPayload,
  validateUpdateNotificationSettingsRequest,
} from "../../src/c10-dto.mjs";

describe("C10 Notification DTO validators", () => {
  it("accepts list query filters from the frozen C10 endpoint", () => {
    const result = validateListNotificationsQuery({
      status: "new",
      category: "critical",
      limit: "25",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      status: "new",
      category: "critical",
      cursor: undefined,
      limit: 25,
    });
  });

  it("rejects unknown notification categories in list query", () => {
    const result = validateListNotificationsQuery({
      category: "marketing",
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /category/);
  });

  it("accepts update settings DTOs", () => {
    const result = validateUpdateNotificationSettingsRequest({
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: "req-settings-1",
      organization_id: "org-1",
      user_id: "manager-1",
      settings: [
        {
          category: "critical",
          channel: "telegram",
          enabled: true,
        },
        {
          category: "warning",
          channel: "email",
          enabled: false,
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.settings[0].channel, "telegram");
  });

  it("rejects settings DTOs with unsupported channels", () => {
    const result = validateUpdateNotificationSettingsRequest({
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: "req-settings-1",
      organization_id: "org-1",
      user_id: "manager-1",
      settings: [
        {
          category: "critical",
          channel: "sms",
          enabled: true,
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /settings\[0\]\.channel/);
  });

  it("accepts producer notification trigger events", () => {
    const result = validateNotificationTriggerEventPayload(
      createNotificationTriggerEvent({
        eventId: "core-message-1:notif",
        producerServiceId: "SVC-CORE",
        producerEventId: "message-1:created",
        organizationId: "org-1",
        recipientUserId: "manager-1",
        category: "info",
        title: "New message",
        body: "Client sent a new message.",
        payload: {
          conversation_id: "conversation-1",
        },
        dedupeKey: "SVC-CORE:message-1:manager-1",
        occurredAt: "2026-07-02T16:30:00.000Z",
      }),
    );

    assert.equal(result.ok, true);
  });
});
