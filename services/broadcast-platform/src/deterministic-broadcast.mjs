import { createHash } from "node:crypto";

import {
  C8_VERSION,
  createBroadcastCoreDeliveryDraft,
  createBroadcastStateChangedEvent,
} from "../../../packages/contracts/src/c8.mjs";
import {
  assertCreateBroadcastRequest,
  assertStartBroadcastRequest,
} from "./c8-dto.mjs";

export function createDeterministicBroadcastMock({
  now = () => new Date().toISOString(),
} = {}) {
  const createdAt = now();
  const broadcasts = new Map([
    [
      "broadcast-1",
      {
        id: "broadcast-1",
        organization_id: "org-1",
        name: "M0 Broadcast Draft",
        status: "draft",
        template: {
          type: "text",
          body: "Здравствуйте, {{client.name}}",
          variables: ["client.name"],
        },
        filter: {
          mode: "all",
          channels: ["web_chat"],
          tags: [],
          segment_ids: [],
          criteria: {},
        },
        schedule: {
          mode: "manual",
        },
        rate_limit: {
          messages_per_minute: 120,
          strategy: "fixed",
        },
        created_by: "manager-1",
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
  ]);
  const stats = new Map();
  const metrics = {
    broadcasts_list_total: 0,
    broadcasts_create_total: 0,
    broadcasts_start_total: 0,
    broadcasts_stats_total: 0,
  };

  return {
    listBroadcasts({ organizationId, requestId = "req-broadcast-list-mock" }) {
      metrics.broadcasts_list_total += 1;

      const items = Array.from(broadcasts.values()).filter(
        (broadcast) => broadcast.organization_id === organizationId,
      );

      return {
        contract: "C8.ListBroadcastsResponse",
        version: C8_VERSION,
        request_id: requestId,
        organization_id: organizationId,
        items,
        page: {
          limit: 50,
          offset: 0,
          total: items.length,
        },
      };
    },

    createBroadcast(payload) {
      const request = assertCreateBroadcastRequest(payload);
      const timestamp = now();
      const broadcast = {
        id: `broadcast-${createStableSlug([
          request.organization_id,
          request.name,
          request.request_id,
        ])}`,
        organization_id: request.organization_id,
        name: request.name,
        status: request.schedule.mode === "scheduled" ? "scheduled" : "draft",
        template: request.template,
        filter: request.filter,
        schedule: request.schedule,
        rate_limit: request.rate_limit,
        created_by: request.created_by,
        created_at: timestamp,
        updated_at: timestamp,
      };

      metrics.broadcasts_create_total += 1;
      broadcasts.set(broadcast.id, broadcast);
      stats.set(broadcast.id, createStats(0, 0, 0, 0, timestamp));

      return {
        contract: "C8.CreateBroadcastResponse",
        version: C8_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast,
      };
    },

    getBroadcast(id, organizationId) {
      const broadcast = broadcasts.get(id);
      if (!broadcast || broadcast.organization_id !== organizationId) {
        throw new BroadcastNotFoundError(id);
      }
      return broadcast;
    },

    startBroadcast(id, payload) {
      const request = assertStartBroadcastRequest(payload);
      const existing = broadcasts.get(id) ?? createImplicitBroadcast(id, request, now());
      const timestamp = now();
      const previousStatus = existing.status;
      const status = request.mode === "scheduled" ? "scheduled" : "running";
      const broadcast = {
        ...existing,
        organization_id: request.organization_id,
        status,
        schedule:
          request.mode === "scheduled"
            ? {
                ...existing.schedule,
                mode: "scheduled",
                scheduled_for: request.scheduled_for,
              }
            : existing.schedule,
        updated_at: timestamp,
      };
      const coreDeliveryDraft = createDeliveryDraft(broadcast, request, timestamp);
      const stateChangedEvent = createBroadcastStateChangedEvent({
        eventId: `${id}:${status}`,
        organizationId: request.organization_id,
        broadcastId: id,
        previousStatus,
        status,
        changedAt: timestamp,
        reason: "mock_started",
      });

      metrics.broadcasts_start_total += 1;
      broadcasts.set(id, broadcast);
      stats.set(id, createStats(10, status === "running" ? 4 : 0, status === "running" ? 3 : 0, status === "running" ? 1 : 0, timestamp));

      return {
        contract: "C8.StartBroadcastResponse",
        version: C8_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast,
        degraded: false,
        fallback_reason: null,
        core_delivery_draft: coreDeliveryDraft,
        state_changed_event: stateChangedEvent,
        created_at: timestamp,
      };
    },

    getStats({
      broadcastId,
      organizationId,
      requestId = "req-broadcast-stats-mock",
    }) {
      metrics.broadcasts_stats_total += 1;

      const broadcast = broadcasts.get(broadcastId) ?? createImplicitBroadcast(
        broadcastId,
        {
          organization_id: organizationId,
          created_by: "system",
        },
        now(),
      );
      const currentStats = stats.get(broadcastId) ?? createStats(10, 0, 0, 0, now());

      return {
        contract: "C8.BroadcastStatsResponse",
        version: C8_VERSION,
        request_id: requestId,
        organization_id: organizationId,
        broadcast_id: broadcastId,
        status: broadcast.status,
        stats: currentStats,
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

export class BroadcastNotFoundError extends Error {
  constructor(id) {
    super(`Broadcast ${id} was not found in the M0 mock.`);
    this.name = "BroadcastNotFoundError";
    this.id = id;
  }
}

function createDeliveryDraft(broadcast, request, timestamp) {
  const canonicalOrganizationId = createDeterministicUuid([
    "organization",
    request.organization_id,
  ]);
  const messageId = createDeterministicUuid([
    "broadcast-message",
    broadcast.id,
    request.idempotency_key,
  ]);

  return createBroadcastCoreDeliveryDraft({
    broadcastId: broadcast.id,
    organizationId: canonicalOrganizationId,
    messageId,
    conversationId: createDeterministicUuid(["conversation", broadcast.id]),
    endpointId: createDeterministicUuid(["endpoint", broadcast.id]),
    channel: broadcast.filter.channels[0] ?? "web_chat",
    text: broadcast.template.body,
    sequenceNumber: 1,
    createdAt: timestamp,
  });
}

function createImplicitBroadcast(id, request, timestamp) {
  return {
    id,
    organization_id: request.organization_id,
    name: `M0 ${id}`,
    status: "draft",
    template: {
      type: "text",
      body: "M0 deterministic broadcast message",
      variables: [],
    },
    filter: {
      mode: "all",
      channels: ["web_chat"],
      tags: [],
      segment_ids: [],
      criteria: {},
    },
    schedule: {
      mode: "manual",
    },
    rate_limit: {
      messages_per_minute: 60,
      strategy: "fixed",
    },
    created_by: request.created_by ?? request.started_by ?? "system",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function createStats(prepared, sent, delivered, failed, updatedAt) {
  return {
    prepared,
    sent,
    delivered,
    failed,
    updated_at: updatedAt,
  };
}

function createStableSlug(parts) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 12);
}

function createDeterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
