import { MOBILE_API_VERSION } from "../../../packages/contracts/src/mobile.mjs";

import {
  buildDialogSummary,
  toMobileMessage,
  toMobileNotification,
} from "./aggregators.mjs";
import { assertSyncRequestQuery } from "./mobile-dto.mjs";
import {
  MobileSyncCursorError,
  assertSyncCursor,
  createSyncCursor,
} from "./sync-cursor.mjs";

/**
 * Движок оффлайн-синхронизации SVC-MOB (M4, ТЗ §19.3). Отдаёт изменения после
 * курсора и новый курсор поверх монотонной ленты изменений мок-Backend.
 *
 * Гарантии устойчивости «оффлайн → онлайн»:
 *  - монотонность — курсор двигается только вперёд (по sequence ленты);
 *  - без потерь — берутся все изменения с `sequence > cursor.sequence`;
 *  - без дублей — повторный sync с тем же курсором отдаёт тот же срез, а клиент
 *    сдвигает курсор лишь применив дельты;
 *  - изоляция арендатора — курсор жёстко привязан к organization_id/user_id.
 */
export function createSyncEngine({
  backend,
  context = {},
  now = () => new Date().toISOString(),
}) {
  const metrics = {
    sync_total: 0,
    sync_empty_total: 0,
    sync_delta_messages_total: 0,
    sync_delta_dialogs_total: 0,
    sync_delta_notifications_total: 0,
    sync_delta_statuses_total: 0,
  };

  return {
    sync(query = {}) {
      const request = assertSyncRequestQuery(query);
      const previous = request.cursor ? assertSyncCursor(request.cursor) : null;

      const organizationId = previous?.organization_id ?? context.organizationId;
      const userId = previous?.user_id ?? context.userId;
      const deviceId =
        request.device_id ?? previous?.device_id ?? context.deviceId ?? "device-unknown";

      // Изоляция арендатора: курсор нельзя переиспользовать в другом контексте.
      if (previous && context.organizationId && previous.organization_id !== context.organizationId) {
        throw new MobileSyncCursorError([
          {
            field: "organization_id",
            message: "cursor.organization_id does not match the authenticated principal.",
          },
        ]);
      }
      if (previous && context.userId && previous.user_id !== context.userId) {
        throw new MobileSyncCursorError([
          {
            field: "user_id",
            message: "cursor.user_id does not match the authenticated principal.",
          },
        ]);
      }

      const sinceSequence = previous?.sequence ?? 0;
      const { changes, lastSequence, hasMore } = backend.getChangesSince({
        organizationId,
        sinceSequence,
        limit: request.limit,
      });

      const newSequence = changes.length ? lastSequence : sinceSequence;
      const deltas = buildDeltas({
        backend,
        organizationId,
        changes,
        watermarkSequence: newSequence,
        now,
      });

      metrics.sync_total += 1;
      if (!changes.length) {
        metrics.sync_empty_total += 1;
      }
      metrics.sync_delta_messages_total += deltas.messages.length;
      metrics.sync_delta_dialogs_total += deltas.dialogs.length;
      metrics.sync_delta_notifications_total += deltas.notifications.length;
      metrics.sync_delta_statuses_total += deltas.statuses.length;

      const cursor = createSyncCursor({
        organizationId,
        userId,
        deviceId,
        sequence: newSequence,
        issuedAt: now(),
      });

      return {
        contract: "MOBILE.SyncResponse",
        version: MOBILE_API_VERSION,
        previous_cursor: request.cursor ?? null,
        cursor,
        has_more: hasMore,
        limit: request.limit,
        source_contracts: ["C3.conversations", "C3.messages", "C7", "C10.notifications"],
        deltas,
        mock: false,
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function buildDeltas({ backend, organizationId, changes, watermarkSequence, now }) {
  const messages = new Map();
  const notifications = new Map();
  const statuses = [];
  const touchedConversations = new Set();

  for (const change of changes) {
    if (change.kind === "message") {
      messages.set(change.entity.id, toMobileMessage(change.entity));
      touchedConversations.add(change.entity.conversation_id);
    } else if (change.kind === "status") {
      touchedConversations.add(change.entity.conversation_id);
      statuses.push({
        kind: "message.status_changed",
        message_id: change.entity.message_id,
        conversation_id: change.entity.conversation_id,
        status: change.entity.status,
        sequence_number: change.entity.sequence_number,
        occurred_at: change.entity.occurred_at ?? change.occurred_at,
      });
    } else if (change.kind === "notification") {
      notifications.set(change.entity.id, toMobileNotification(change.entity));
    }
  }

  const dialogs = buildDialogDeltas({ backend, organizationId, touchedConversations });

  // Ватермарка: контрольная точка синхронизации до достигнутого sequence.
  statuses.push({
    kind: "sync.watermark",
    sequence: watermarkSequence,
    occurred_at: now(),
  });

  return {
    dialogs,
    messages: [...messages.values()],
    notifications: [...notifications.values()],
    statuses,
  };
}

function buildDialogDeltas({ backend, organizationId, touchedConversations }) {
  if (touchedConversations.size === 0) {
    return [];
  }

  const conversationsById = new Map(
    backend
      .listConversations({ organizationId })
      .map((conversation) => [conversation.id, conversation]),
  );

  return [...touchedConversations]
    .map((conversationId) => {
      const conversation =
        conversationsById.get(conversationId) ?? {
          id: conversationId,
          organization_id: organizationId,
          client_id: null,
        };
      const messages = backend.listConversationMessages({ organizationId, conversationId });
      const client = conversation.client_id
        ? backend.getClient({ organizationId, clientId: conversation.client_id })
        : null;
      return buildDialogSummary({ conversation, messages, client });
    })
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}
