import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C7_EVENT_TYPES,
  C7_RECONNECT_SEMANTICS,
  C7_WS_PATH,
  C7_WS_SUBSCRIPTION_FILTERS,
  createWebSocketEvent,
  validateWebSocketEvent,
} from "../../src/c7.js";

describe("C7 WebSocket event schema", () => {
  it("freezes the M0 WebSocket endpoint and event names", () => {
    assert.equal(C7_WS_PATH, "/ws");
    assert.deepEqual(C7_EVENT_TYPES, [
      "message.created",
      "message.status_changed",
      "typing.started",
      "typing.stopped",
      "client.status_changed",
      "channel.status_changed",
      "notification.created",
      "broadcast.state_changed",
      "workflow.state_changed",
    ]);
  });

  it("validates each frozen event name through the common C7 envelope", () => {
    for (const [index, event] of C7_EVENT_TYPES.entries()) {
      const wsEvent = createWebSocketEvent({
        eventId: `event-${index + 1}`,
        organizationId: "org-1",
        event,
        sequenceNumber: index + 1,
        payload: {
          mock: true,
          event,
        },
        occurredAt: "2026-07-02T16:20:00.000Z",
      });

      const validation = validateWebSocketEvent(wsEvent);
      assert.equal(validation.valid, true, validation.errors.join("\n"));
    }
  });

  it("rejects unknown event names before clients depend on them", () => {
    const validation = validateWebSocketEvent({
      contract: "C7.WebSocketEvent",
      version: "1.0.0",
      event: "message.deleted",
      event_id: "event-1",
      organization_id: "org-1",
      sequence_number: 1,
      payload: {},
      occurred_at: "2026-07-02T16:20:00.000Z",
    });

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /message\.deleted/);
  });

  it("documents reconnect semantics with a last_event_id resume cursor", () => {
    assert.deepEqual(C7_RECONNECT_SEMANTICS, {
      mode: "client_auto_reconnect",
      resume_cursor: "last_event_id",
      fallback_cursor: "after_sequence_number",
      delivery: "at_least_once_with_client_dedup",
      duplicate_rule: "drop events with event_id already observed by the client",
      ordering: "sequence_number is monotonic inside one WebSocket subscription",
    });
  });

  it("documents optional transport filters for routed C7 subscriptions", () => {
    assert.deepEqual(C7_WS_SUBSCRIPTION_FILTERS, [
      "organization_id",
      "subscription_id",
      "conversation_id",
      "endpoint_id",
      "client_id",
      "recipient_user_id",
      "user_id",
      "manager_user_id",
      "visitor_session_id",
    ]);
  });
});
