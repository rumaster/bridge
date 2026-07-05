/**
 * Мок-Backend для SVC-MOB (M4). Смоделированные апстримы, которые мобильный BFF
 * агрегирует и проксирует: C3.conversations/messages/clients и C10.notifications
 * (ТЗ §19.2–§19.3). Границы §1: SVC-MOB не владеет доменными таблицами, поэтому
 * здесь — упрощённое ядро «как его видит мобильный BFF» с монотонной лентой
 * изменений (change feed) для дельта-синхронизации.
 *
 * Ключевые инварианты:
 *  - монотонный per-organization `sequence` ленты изменений — основа устойчивой
 *    оффлайн→онлайн синхронизации без потерь и дублей (ТЗ §19.3, §7.10);
 *  - идемпотентный `sendMessage` по `idempotency_key = message_id` (ТЗ §11.12);
 *  - порядок сообщений в разговоре строго по `sequence_number` (ТЗ §7.10);
 *  - изоляция арендатора — всё адресуется `organization_id`.
 *
 * Модуль не тянет рантайм-зависимостей и детерминирован (инъектируемые часы).
 */

export interface BackendClientInput {
  clientId: string;
  displayName?: string;
}

export interface BackendConversationInput {
  conversationId: string;
  clientId?: string;
  createdAt?: string;
}

export interface SeedClientInput {
  organizationId: string;
  clientId: string;
  displayName?: string;
}

export interface SeedConversationInput {
  organizationId: string;
  conversationId: string;
  clientId?: string;
  displayName?: string;
  createdAt?: string;
}

export interface SendMessageInput {
  organizationId: string;
  conversationId: string;
  messageId: string;
  idempotencyKey: string;
  senderType?: string;
  senderUserId?: string;
  text?: string;
  occurredAt?: string;
}

export interface ApplyStatusChangeInput {
  organizationId: string;
  messageId: string;
  status: string;
  occurredAt?: string;
}

export interface CreateNotificationInput {
  organizationId: string;
  notificationId: string;
  recipientUserId: string;
  category?: string;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

const SENDER_TYPES = new Set(["client", "manager", "system", "ai"]);

export function createMockBackendApi({ now = () => new Date().toISOString() } = {}) {
  const organizations = new Map();
  const seenEventIds = new Set();
  const metrics = {
    messages_sent_total: 0,
    messages_deduplicated_total: 0,
    edge_ingested_total: 0,
    edge_duplicate_total: 0,
    realtime_ingested_total: 0,
    realtime_duplicate_total: 0,
    typing_events_total: 0,
    notifications_created_total: 0,
    changes_total: 0,
  };

  function orgState(organizationId) {
    if (!organizationId) {
      throw new TypeError("organization_id is required for backend access");
    }

    let state = organizations.get(organizationId);
    if (!state) {
      state = {
        organizationId,
        conversations: new Map(),
        messages: new Map(),
        clients: new Map(),
        notifications: new Map(),
        idempotencyIndex: new Map(),
        conversationSequence: new Map(),
        feed: [],
        feedSequence: 0,
      };
      organizations.set(organizationId, state);
    }
    return state;
  }

  function appendChange(state, kind, entity, occurredAt) {
    state.feedSequence += 1;
    tagEntityWithSyncSequence(entity, state.feedSequence);
    const change = {
      sequence: state.feedSequence,
      kind,
      organization_id: state.organizationId,
      occurred_at: occurredAt ?? entity.occurred_at ?? entity.created_at ?? now(),
      entity: structuredClone(entity),
    };
    state.feed.push(change);
    metrics.changes_total += 1;
    return change;
  }

  function tagEntityWithSyncSequence(entity, sequence) {
    if (entity && typeof entity === "object") {
      Object.defineProperty(entity, "sync_sequence", {
        value: sequence,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }

  function ensureConversation(state, { conversationId, clientId, createdAt }: BackendConversationInput) {
    let conversation = state.conversations.get(conversationId);
    if (!conversation) {
      const resolvedClientId = clientId ?? `client-of-${conversationId}`;
      ensureClient(state, { clientId: resolvedClientId });
      conversation = {
        id: conversationId,
        organization_id: state.organizationId,
        client_id: resolvedClientId,
        created_at: createdAt ?? now(),
        updated_at: createdAt ?? now(),
        last_message_id: null,
      };
      state.conversations.set(conversationId, conversation);
    }
    return conversation;
  }

  function ensureClient(state, { clientId, displayName }: BackendClientInput) {
    let client = state.clients.get(clientId);
    if (!client) {
      client = {
        id: clientId,
        organization_id: state.organizationId,
        display_name: displayName ?? `Client ${clientId}`,
      };
      state.clients.set(clientId, client);
    } else if (displayName && client.display_name !== displayName) {
      client.display_name = displayName;
    }
    return client;
  }

  function nextConversationSequence(state, conversationId) {
    const current = state.conversationSequence.get(conversationId) ?? 0;
    const next = current + 1;
    state.conversationSequence.set(conversationId, next);
    return next;
  }

  function noteExternalSequence(state, conversationId, sequenceNumber) {
    if (Number.isSafeInteger(sequenceNumber)) {
      const current = state.conversationSequence.get(conversationId) ?? 0;
      state.conversationSequence.set(conversationId, Math.max(current, sequenceNumber));
    }
  }

  function storeMessage(state, message) {
    state.messages.set(message.id, message);
    if (message.idempotency_key) {
      state.idempotencyIndex.set(message.idempotency_key, message.id);
    }
    const conversation = ensureConversation(state, {
      conversationId: message.conversation_id,
    });
    conversation.updated_at = message.occurred_at;
    conversation.last_message_id = message.id;
    return message;
  }

  return {
    /** Тестовый посев клиента C3.clients. */
    seedClient({ organizationId, clientId, displayName }: SeedClientInput) {
      return { ...ensureClient(orgState(organizationId), { clientId, displayName }) };
    },

    /** Тестовый посев разговора C3.conversations. */
    seedConversation({ organizationId, conversationId, clientId, displayName, createdAt }: SeedConversationInput) {
      const state = orgState(organizationId);
      if (clientId) {
        ensureClient(state, { clientId, displayName });
      }
      return { ...ensureConversation(state, { conversationId, clientId, createdAt }) };
    },

    /**
     * Идемпотентная отправка исходящего сообщения (проксирование в C3.messages,
     * ТЗ §11.12). Повтор с тем же idempotency_key не создаёт дубля.
     */
    sendMessage({
      organizationId,
      conversationId,
      messageId,
      idempotencyKey,
      senderType = "manager",
      senderUserId,
      text = "",
      occurredAt,
    }: SendMessageInput) {
      if (idempotencyKey !== messageId) {
        throw new TypeError("idempotency_key must equal message_id (ТЗ §11.12)");
      }
      if (!SENDER_TYPES.has(senderType)) {
        throw new TypeError(`Unsupported sender_type: ${senderType}`);
      }
      const state = orgState(organizationId);

      const existingId = state.idempotencyIndex.get(idempotencyKey) ?? (state.messages.has(messageId) ? messageId : undefined);
      if (existingId) {
        metrics.messages_deduplicated_total += 1;
        return { duplicate: true, message: cloneMessage(state.messages.get(existingId)) };
      }

      const at = occurredAt ?? now();
      const message = storeMessage(state, {
        id: messageId,
        idempotency_key: idempotencyKey,
        organization_id: organizationId,
        conversation_id: conversationId,
        sender_type: senderType,
        sender_user_id: senderUserId ?? null,
        text,
        sequence_number: nextConversationSequence(state, conversationId),
        status: "sent",
        occurred_at: at,
      });
      metrics.messages_sent_total += 1;
      appendChange(state, "message", message, at);
      return { duplicate: false, message: cloneMessage(message) };
    },

    /**
     * Приём канонического сообщения (например, входящего от клиента РФ, пришедшего
     * из Edge-буфера, ТЗ §7.9). Дедуп по idempotency_key, порядок — по внешнему
     * sequence_number.
     */
    ingestCanonicalMessage(input) {
      const canonical = input?.payload ?? input;
      const organizationId = canonical.organization_id;
      const state = orgState(organizationId);
      const idempotencyKey = canonical.idempotency_key ?? canonical.id;

      const existingId = state.idempotencyIndex.get(idempotencyKey) ?? (state.messages.has(canonical.id) ? canonical.id : undefined);
      if (existingId) {
        metrics.edge_duplicate_total += 1;
        return { duplicate: true, message: cloneMessage(state.messages.get(existingId)) };
      }

      const at = canonical.created_at ?? now();
      const sequenceNumber = canonical.sequence_number;
      noteExternalSequence(state, canonical.conversation_id, sequenceNumber);
      const message = storeMessage(state, {
        id: canonical.id,
        idempotency_key: idempotencyKey,
        organization_id: organizationId,
        conversation_id: canonical.conversation_id,
        sender_type: canonical.sender_type ?? directionToSender(canonical.direction),
        sender_user_id: canonical.sender_user_id ?? null,
        text: canonical.content?.text ?? canonical.text ?? "",
        sequence_number: sequenceNumber,
        status: canonical.status ?? "received",
        occurred_at: at,
      });
      metrics.edge_ingested_total += 1;
      appendChange(state, "message", message, at);
      return { duplicate: false, message: cloneMessage(message) };
    },

    /**
     * Дренаж пачки из Edge-буфера. Восстанавливает порядок (сортировка по
     * sequence_number) и снимает дубли — консистентность CP-7 (ТЗ §7.9/§7.10).
     */
    ingestEdgeBatch(messages) {
      const ordered = [...messages].sort(
        (a, b) => (a?.payload ?? a).sequence_number - (b?.payload ?? b).sequence_number,
      );
      let ingested = 0;
      let duplicates = 0;
      for (const message of ordered) {
        const result = this.ingestCanonicalMessage(message);
        if (result.duplicate) {
          duplicates += 1;
        } else {
          ingested += 1;
        }
      }
      return { ingested, duplicates, ordered: true };
    },

    /** Смена статуса сообщения (C3.messages / C7 message.status_changed). */
    applyStatusChange({ organizationId, messageId, status, occurredAt }: ApplyStatusChangeInput) {
      const state = orgState(organizationId);
      const message = state.messages.get(messageId);
      if (!message) {
        return null;
      }
      const at = occurredAt ?? now();
      message.status = status;
      appendChange(
        state,
        "status",
        {
          message_id: message.id,
          conversation_id: message.conversation_id,
          organization_id: organizationId,
          status,
          sequence_number: message.sequence_number,
          occurred_at: at,
        },
        at,
      );
      return cloneMessage(message);
    },

    /** Создание уведомления C10.notifications. */
    createNotification({
      organizationId,
      notificationId,
      recipientUserId,
      category = "info",
      title = "",
      body = "",
      payload = {},
      createdAt,
    }: CreateNotificationInput) {
      const state = orgState(organizationId);
      const at = createdAt ?? now();
      const notification = {
        id: notificationId,
        organization_id: organizationId,
        recipient_user_id: recipientUserId,
        category,
        title,
        body,
        payload,
        status: "new",
        created_at: at,
        read_at: null,
      };
      state.notifications.set(notificationId, notification);
      metrics.notifications_created_total += 1;
      appendChange(state, "notification", notification, at);
      return { ...notification };
    },

    /**
     * Приём C7-события realtime (потребление §19.3). Дедуп по event_id — событие,
     * уже учтённое, не порождает второй записи в ленте (устойчивость к повторам WS).
     */
    ingestRealtimeEvent(event) {
      const eventId = event?.event_id;
      if (eventId && seenEventIds.has(eventId)) {
        metrics.realtime_duplicate_total += 1;
        return { duplicate: true, kind: event.event };
      }
      if (eventId) {
        seenEventIds.add(eventId);
      }

      const type = event.event;
      const organizationId = event.organization_id ?? event.organizationId;
      const occurredAt = event.occurred_at ?? event.occurredAt ?? now();

      if (type === "typing.started" || type === "typing.stopped") {
        metrics.typing_events_total += 1;
        return { duplicate: false, kind: type };
      }

      if (type === "notification.created") {
        const notification = event.notification ?? event.payload?.notification;
        const state = orgState(organizationId);
        if (!state.notifications.has(notification.id)) {
          state.notifications.set(notification.id, structuredClone(notification));
          metrics.notifications_created_total += 1;
        }
        appendChange(state, "notification", state.notifications.get(notification.id), occurredAt);
        metrics.realtime_ingested_total += 1;
        return { duplicate: false, kind: type };
      }

      if (type === "message.status_changed") {
        const payload = event.payload ?? {};
        this.applyStatusChange({
          organizationId,
          messageId: payload.message_id,
          status: payload.status,
          occurredAt,
        });
        metrics.realtime_ingested_total += 1;
        return { duplicate: false, kind: type };
      }

      if (type === "message.created") {
        const payload = event.payload ?? {};
        const state = orgState(organizationId);
        let message = state.messages.get(payload.message_id);
        if (!message) {
          const sequenceNumber = payload.sequence_number;
          noteExternalSequence(state, payload.conversation_id, sequenceNumber);
          message = storeMessage(state, {
            id: payload.message_id,
            idempotency_key: payload.idempotency_key ?? payload.message_id,
            organization_id: organizationId,
            conversation_id: payload.conversation_id,
            sender_type: payload.sender_type ?? directionToSender(payload.direction),
            sender_user_id: payload.sender_user_id ?? null,
            text: payload.text ?? "",
            sequence_number: sequenceNumber,
            status: payload.status ?? "received",
            occurred_at: occurredAt,
          });
        }
        appendChange(state, "message", message, occurredAt);
        metrics.realtime_ingested_total += 1;
        return { duplicate: false, kind: type };
      }

      metrics.realtime_ingested_total += 1;
      return { duplicate: false, kind: type };
    },

    /** Дельты ленты изменений после курсора (основа GET /mobile/v1/sync). */
    getChangesSince({ organizationId, sinceSequence = 0, limit = 100 }) {
      const state = orgState(organizationId);
      const pending = state.feed.filter((change) => change.sequence > sinceSequence);
      const hasMore = pending.length > limit;
      const changes = pending.slice(0, limit).map((change) => structuredClone(change));
      const lastSequence = changes.length
        ? changes[changes.length - 1].sequence
        : sinceSequence;
      return { changes, lastSequence, hasMore };
    },

    /** Текущий максимальный sequence ленты для организации. */
    currentSequence(organizationId) {
      return orgState(organizationId).feedSequence;
    },

    listConversations({ organizationId, limit = 100 }) {
      const state = orgState(organizationId);
      return [...state.conversations.values()]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, limit)
        .map((conversation) => ({ ...conversation }));
    },

    listConversationMessages({
      organizationId,
      conversationId,
      limit = 200,
      maxSyncSequence = Number.POSITIVE_INFINITY,
    }) {
      const state = orgState(organizationId);
      return [...state.messages.values()]
        .filter((message) => message.conversation_id === conversationId)
        .filter(
          (message) =>
            (message.sync_sequence ?? Number.POSITIVE_INFINITY) <= maxSyncSequence,
        )
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, limit)
        .map((message) => cloneMessage(message));
    },

    getClient({ organizationId, clientId }) {
      const client = orgState(organizationId).clients.get(clientId);
      return client ? { ...client } : null;
    },

    listNotifications({ organizationId, recipientUserId, limit = 100 }) {
      const state = orgState(organizationId);
      return [...state.notifications.values()]
        .filter(
          (notification) =>
            !recipientUserId || notification.recipient_user_id === recipientUserId,
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((notification) => ({ ...notification }));
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function directionToSender(direction) {
  if (direction === "outbound") {
    return "manager";
  }
  return "client";
}

function cloneMessage(message) {
  return message ? { ...message } : message;
}
