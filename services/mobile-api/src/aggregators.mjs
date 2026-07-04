/**
 * Агрегаторы SVC-MOB (M4): чистые трансформы апстрим-данных C3.* и C10 в «экранные»
 * мобильные DTO по замороженному контракту MOBILE.v1 (ТЗ §19.2–§19.3). Здесь нет
 * бизнес-логики и обращений к хранилищам — только композиция и переупаковка
 * (границы §1). Все функции детерминированы и не мутируют вход.
 *
 * Соответствие OpenAPI (packages/contracts/openapi/mobile/mobile.v1.openapi.json):
 *  - MobileDialog / MobileMessage / MobileNotification (+ preview) — поля строго
 *    по схеме (additionalProperties: false), лишние поля апстрима отбрасываются.
 */

const SENDER_TYPES = new Set(["client", "manager", "system", "ai"]);

/** Клиентские сообщения считаются непрочитанными, пока не переведены в read/seen. */
const READ_STATUSES = new Set(["read", "seen"]);

/** C10-категория уведомления → severity мобильного контракта (info/warning/critical). */
export function mapCategoryToSeverity(category) {
  switch (category) {
    case "critical":
    case "error":
      return "critical";
    case "warning":
    case "admin":
      return "warning";
    default:
      return "info";
  }
}

export function toMobileClientPreview(client) {
  return {
    client_id: client.id ?? client.client_id,
    display_name: client.display_name ?? "",
  };
}

export function toMobileMessagePreview(message) {
  return {
    message_id: message.id ?? message.message_id,
    sender_type: normalizeSenderType(message.sender_type),
    text: message.text ?? "",
    occurred_at: message.occurred_at ?? message.created_at,
  };
}

export function toMobileMessage(message) {
  const conversationId = message.conversation_id;
  return {
    message_id: message.id ?? message.message_id,
    dialog_id: conversationId,
    conversation_id: conversationId,
    sender_type: normalizeSenderType(message.sender_type),
    text: message.text ?? "",
    sequence_number: message.sequence_number,
    status: message.status,
    occurred_at: message.occurred_at ?? message.created_at,
  };
}

export function toMobileNotification(notification) {
  const readAt =
    notification.read_at ??
    (notification.status === "read" ? notification.created_at : null);
  return {
    notification_id: notification.id ?? notification.notification_id,
    organization_id: notification.organization_id,
    user_id: notification.recipient_user_id ?? notification.user_id,
    title: notification.title ?? "",
    body: notification.body ?? "",
    severity: mapCategoryToSeverity(notification.category ?? notification.severity),
    data: notification.payload ?? notification.data ?? {},
    created_at: notification.created_at,
    read_at: readAt,
  };
}

/**
 * Сводка диалога: последнее сообщение (по sequence_number) как превью и счётчик
 * непрочитанных входящих (client → не read). updated_at — момент последнего
 * сообщения либо разговора.
 */
export function buildDialogSummary({ conversation, messages, client }) {
  const ordered = [...messages].sort((a, b) => a.sequence_number - b.sequence_number);
  const last = ordered[ordered.length - 1];
  const unreadCount = ordered.filter(
    (message) => message.sender_type === "client" && !READ_STATUSES.has(message.status),
  ).length;

  return {
    dialog_id: conversation.id ?? conversation.conversation_id,
    conversation_id: conversation.id ?? conversation.conversation_id,
    organization_id: conversation.organization_id,
    client: toMobileClientPreview(
      client ?? { id: conversation.client_id, display_name: "" },
    ),
    last_message: last
      ? toMobileMessagePreview(last)
      : {
          message_id: `${conversation.id ?? conversation.conversation_id}:empty`,
          sender_type: "system",
          text: "",
          occurred_at: conversation.updated_at ?? conversation.created_at,
        },
    unread_count: unreadCount,
    updated_at: last?.occurred_at ?? conversation.updated_at ?? conversation.created_at,
  };
}

/** Список диалогов «экрана» — по разговорам, свежие сверху (по updated_at). */
export function aggregateDialogList({ conversations, messagesByConversation, clientsById }) {
  return conversations
    .map((conversation) =>
      buildDialogSummary({
        conversation,
        messages: messagesByConversation.get(conversation.id ?? conversation.conversation_id) ?? [],
        client: clientsById.get(conversation.client_id),
      }),
    )
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

/** История сообщений диалога — строго по возрастанию sequence_number (ТЗ §7.10). */
export function aggregateDialogMessages({ messages }) {
  return [...messages]
    .sort((a, b) => a.sequence_number - b.sequence_number)
    .map((message) => toMobileMessage(message));
}

/** Лента уведомлений — свежие сверху. */
export function aggregateNotifications({ notifications }) {
  return notifications
    .map((notification) => toMobileNotification(notification))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function normalizeSenderType(senderType) {
  return SENDER_TYPES.has(senderType) ? senderType : "system";
}
