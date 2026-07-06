import { createHash } from "node:crypto";

import { C8_VERSION } from "../../../packages/contracts/src/c8.js";
import {
  assertCreateBroadcastRequest,
  assertStartBroadcastRequest,
} from "./c8-dto.js";
import {
  buildBroadcastDraft,
  createCampaignRunner,
  createInMemoryCoreDelivery,
} from "./campaign/index.js";

/** Опции детерминированного мока SVC-BCAST (dev-сервер / тесты). */
export interface DeterministicBroadcastMockOptions {
  now?: () => string;
  core?: any;
  recipientsPerBroadcast?: number;
}

export function createDeterministicBroadcastMock({
  now = () => new Date().toISOString(),
  core,
  recipientsPerBroadcast = 3,
}: DeterministicBroadcastMockOptions = {}) {
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

  // Единый механизм ядра (C1/C2). По умолчанию — in-memory мок; в тестах и
  // интеграции подставляется реальный координатор доставки SVC-CORE (CP-6).
  const coreDelivery = core ?? createInMemoryCoreDelivery();
  const runner = createCampaignRunner({
    core: coreDelivery,
    clock: now,
    // Dev-мок не блокируется на backpressure — пауза мгновенная.
    sleep: async () => {},
  });

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

    async startBroadcast(id, payload) {
      const request = assertStartBroadcastRequest(payload);
      const existing =
        broadcasts.get(id) ?? createImplicitBroadcast(id, request, now());
      const timestamp = now();

      // Канонический вид кампании для ядра: organization_id и получатели — UUID
      // (требование C1). Публичные C8-идентификаторы остаются как есть.
      const canonicalOrganizationId = createDeterministicUuid([
        "organization",
        request.organization_id,
      ]);
      const canonicalBroadcast = {
        ...existing,
        organization_id: canonicalOrganizationId,
      };
      const recipients = materializeRecipients(
        existing,
        canonicalOrganizationId,
        recipientsPerBroadcast,
      );
      const startIdempotencyKey = request.idempotency_key;

      const drafts = recipients.map(
        (recipient) =>
          buildBroadcastDraft({
            broadcast: canonicalBroadcast,
            recipient,
            startIdempotencyKey,
            createdAt: timestamp,
          }).draft,
      );

      metrics.broadcasts_start_total += 1;

      // Запланированный запуск не доставляет немедленно — только фиксирует статус.
      if (request.mode === "scheduled") {
        const scheduled = {
          ...existing,
          organization_id: request.organization_id,
          status: "scheduled",
          schedule: {
            ...existing.schedule,
            mode: "scheduled",
            scheduled_for: request.scheduled_for,
          },
          updated_at: timestamp,
        };
        broadcasts.set(id, scheduled);
        stats.set(id, createStats(0, 0, 0, 0, timestamp));

        return {
          contract: "C8.StartBroadcastResponse",
          version: C8_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          broadcast: scheduled,
          degraded: false,
          fallback_reason: null,
          core_delivery_draft: drafts[0] ?? null,
          core_delivery_drafts: drafts,
          stats: stats.get(id),
          state_changed_events: [],
          state_changed_event: null,
          created_at: timestamp,
        };
      }

      // Немедленный запуск: идемпотентная генерация и доставка ЧЕРЕЗ единый
      // механизм ядра (C1/C2), сбор `broadcast_stats` и событий C7 (CP-6).
      const runResult = await runner.run(canonicalBroadcast, recipients, {
        startIdempotencyKey,
        mode: request.mode,
      });

      const broadcast = {
        ...existing,
        organization_id: request.organization_id,
        status: runResult.status,
        updated_at: timestamp,
      };
      broadcasts.set(id, broadcast);
      stats.set(id, runResult.stats);

      return {
        contract: "C8.StartBroadcastResponse",
        version: C8_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast,
        degraded: false,
        fallback_reason: null,
        core_delivery_draft: drafts[0] ?? null,
        core_delivery_drafts: drafts,
        stats: runResult.stats,
        state_changed_events: runResult.events,
        state_changed_event:
          runResult.events[runResult.events.length - 1] ?? null,
        created_at: timestamp,
      };
    },

    getStats({
      broadcastId,
      organizationId,
      requestId = "req-broadcast-stats-mock",
    }) {
      metrics.broadcasts_stats_total += 1;

      const broadcast =
        broadcasts.get(broadcastId) ??
        createImplicitBroadcast(
          broadcastId,
          {
            organization_id: organizationId,
            created_by: "system",
          },
          now(),
        );
      const currentStats =
        stats.get(broadcastId) ?? createStats(0, 0, 0, 0, now());

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

    /** Доступ к единому механизму ядра — для интеграционных/e2e-проверок. */
    getCoreDelivery() {
      return coreDelivery;
    },
  };
}

export class BroadcastNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Broadcast ${id} was not found in the M0 mock.`);
    this.name = "BroadcastNotFoundError";
    this.id = id;
  }
}

/**
 * Материализация сегмента получателей кампании (`broadcast_recipients`, ТЗ §14.4).
 *
 * В dev-моке сегмент детерминирован: N получателей на первом канале фильтра.
 * В проде сегмент строится из C3.clients на момент запуска (плана §5, M3).
 */
function materializeRecipients(broadcast, organizationId, count) {
  const channel = broadcast.filter?.channels?.[0] ?? "web_chat";

  return Array.from({ length: count }, (_unused, index) => {
    const clientId = `client-${index + 1}`;
    return {
      client_id: clientId,
      endpoint_id: createDeterministicUuid(["endpoint", broadcast.id, clientId]),
      conversation_id: createDeterministicUuid([
        "conversation",
        broadcast.id,
        clientId,
      ]),
      channel,
      sequence_number: 1,
      context: {
        client: { name: `Клиент ${index + 1}` },
        organization: { id: organizationId },
      },
    };
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
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 12);
}

function createDeterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.join("")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
