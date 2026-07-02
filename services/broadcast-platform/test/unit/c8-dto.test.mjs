import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateBroadcastStatsResponse,
  validateCreateBroadcastRequest,
  validateStartBroadcastRequest,
} from "../../src/c8-dto.mjs";

describe("C8 Broadcast DTO validators", () => {
  it("accepts the frozen broadcast create DTO", () => {
    const result = validateCreateBroadcastRequest({
      contract: "C8.CreateBroadcastRequest",
      version: "1.0.0",
      request_id: "req-broadcast-create-1",
      organization_id: "org-1",
      created_by: "manager-1",
      name: "Июльская рассылка",
      template: {
        type: "text",
        body: "Здравствуйте, {{client.name}}. Ваш промокод JULY.",
        locale: "ru-RU",
      },
      filter: {
        mode: "all",
        channels: ["telegram", "web_chat"],
        tags: ["promo"],
      },
      schedule: {
        mode: "manual",
      },
      rate_limit: {
        messages_per_minute: 120,
        strategy: "channel_capability",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.name, "Июльская рассылка");
    assert.equal(result.value.template.type, "text");
    assert.deepEqual(result.value.filter.channels, ["telegram", "web_chat"]);
  });

  it("rejects create DTOs with unknown fields and invalid rate limits", () => {
    const result = validateCreateBroadcastRequest({
      contract: "C8.CreateBroadcastRequest",
      version: "1.0.0",
      request_id: "req-broadcast-create-1",
      organization_id: "org-1",
      created_by: "manager-1",
      name: "Июльская рассылка",
      template: {
        type: "text",
        body: "Здравствуйте",
      },
      filter: {
        mode: "all",
      },
      schedule: {
        mode: "manual",
      },
      rate_limit: {
        messages_per_minute: 0,
      },
      direct_delivery: true,
    });

    assert.equal(result.ok, false);
    assert.match(
      result.errors.map((error) => error.field).join(","),
      /direct_delivery|rate_limit\.messages_per_minute/,
    );
  });

  it("accepts immediate broadcast start DTOs", () => {
    const result = validateStartBroadcastRequest({
      contract: "C8.StartBroadcastRequest",
      version: "1.0.0",
      request_id: "req-broadcast-start-1",
      organization_id: "org-1",
      started_by: "manager-1",
      mode: "immediate",
      idempotency_key: "broadcast-start-idempotency-1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.mode, "immediate");
  });

  it("rejects scheduled start DTOs without scheduled_for", () => {
    const result = validateStartBroadcastRequest({
      contract: "C8.StartBroadcastRequest",
      version: "1.0.0",
      request_id: "req-broadcast-start-1",
      organization_id: "org-1",
      started_by: "manager-1",
      mode: "scheduled",
    });

    assert.equal(result.ok, false);
    assert.match(
      result.errors.map((error) => error.field).join(","),
      /scheduled_for/,
    );
  });

  it("accepts broadcast stats DTOs", () => {
    const result = validateBroadcastStatsResponse({
      contract: "C8.BroadcastStatsResponse",
      version: "1.0.0",
      request_id: "req-broadcast-stats-1",
      organization_id: "org-1",
      broadcast_id: "broadcast-1",
      status: "running",
      stats: {
        prepared: 42,
        sent: 41,
        delivered: 39,
        failed: 2,
        updated_at: "2026-07-02T16:30:00.000Z",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.stats.prepared, 42);
  });

  it("rejects stats where delivered plus failed exceeds sent", () => {
    const result = validateBroadcastStatsResponse({
      contract: "C8.BroadcastStatsResponse",
      version: "1.0.0",
      request_id: "req-broadcast-stats-1",
      organization_id: "org-1",
      broadcast_id: "broadcast-1",
      status: "running",
      stats: {
        prepared: 10,
        sent: 5,
        delivered: 4,
        failed: 2,
        updated_at: "2026-07-02T16:30:00.000Z",
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /stats/);
  });
});
