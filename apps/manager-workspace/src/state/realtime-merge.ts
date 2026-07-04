import type {
  C7Event,
  ClientProfile,
  Conversation,
  Message,
  NotificationItem
} from "../api/client/types";

export function isC7SequenceGap(lastSequenceNumber: number | null, nextSequenceNumber: number) {
  return lastSequenceNumber !== null && nextSequenceNumber > lastSequenceNumber + 1;
}

export function advanceC7Sequence(lastSequenceNumber: number | null, event: C7Event) {
  return Math.max(lastSequenceNumber ?? 0, event.sequence_number);
}

export function markC7EventSeen(seenEventIds: Set<string>, event: C7Event) {
  if (seenEventIds.has(event.event_id)) {
    return false;
  }

  seenEventIds.add(event.event_id);
  return true;
}

export function mergeMessagesById(currentMessages: Message[], nextMessages: Message[]) {
  const messagesById = new Map(currentMessages.map((message) => [message.id, message]));

  for (const message of nextMessages) {
    messagesById.set(message.id, {
      ...messagesById.get(message.id),
      ...message
    });
  }

  return [...messagesById.values()].sort(compareMessagesByCreatedAt);
}

export function applyC7EventToMessages(messages: Message[], event: C7Event) {
  if (event.event === "message.created") {
    return mergeMessagesById(messages, [event.payload.message]);
  }

  if (event.event === "message.status_changed") {
    return messages.map((message) =>
      message.id === event.payload.message_id
        ? {
            ...message,
            status: event.payload.status
          }
        : message
    );
  }

  return messages;
}

export function applyC7EventToConversations(
  conversations: Conversation[],
  event: C7Event,
  seenMessageIds?: Set<string>
) {
  if (event.event !== "message.created") {
    return conversations;
  }

  const { message } = event.payload;
  const duplicateMessage = seenMessageIds?.has(message.id) ?? false;

  return conversations
    .map((conversation) => {
      if (conversation.id !== message.conversationId) {
        return conversation;
      }

      seenMessageIds?.add(message.id);

      if (duplicateMessage) {
        return conversation;
      }

      return {
        ...conversation,
        channel: message.channel,
        lastMessageAt:
          message.createdAt.localeCompare(conversation.lastMessageAt) > 0
            ? message.createdAt
            : conversation.lastMessageAt,
        lastMessagePreview:
          message.createdAt.localeCompare(conversation.lastMessageAt) >= 0
            ? message.content
            : conversation.lastMessagePreview,
        unreadCount:
          message.direction === "inbound" ? conversation.unreadCount + 1 : conversation.unreadCount
      };
    })
    .sort(compareConversationsByLastMessageAt);
}

export function applyC7EventToClients(clients: ClientProfile[], event: C7Event) {
  if (event.event !== "client.status_changed") {
    return clients;
  }

  return clients.map((client) =>
    client.id === event.payload.client_id
      ? {
          ...client,
          status: event.payload.status
        }
      : client
  );
}

export function applyC7EventToTypingClientIds(
  typingClientIds: string[],
  event: C7Event,
  conversationId: string
) {
  if (event.event !== "typing.started" && event.event !== "typing.stopped") {
    return typingClientIds;
  }

  if (event.payload.conversation_id !== conversationId) {
    return typingClientIds;
  }

  const nextTypingClientIds = new Set(typingClientIds);

  if (event.event === "typing.started") {
    nextTypingClientIds.add(event.payload.client_id);
  } else {
    nextTypingClientIds.delete(event.payload.client_id);
  }

  return [...nextTypingClientIds];
}

export function applyC7EventToNotifications(notifications: NotificationItem[], event: C7Event) {
  if (event.event !== "notification.created") {
    return notifications;
  }

  if (notifications.some((notification) => notification.id === event.payload.notification.id)) {
    return notifications;
  }

  return [event.payload.notification, ...notifications].sort(compareNotificationsByCreatedAt);
}

export function sortNotificationsByCreatedAt(notifications: NotificationItem[]) {
  return [...notifications].sort(compareNotificationsByCreatedAt);
}

/**
 * Объединяет снимок ленты C10 `GET /notifications` с текущим состоянием так,
 * чтобы realtime-уведомления C7, пришедшие во время загрузки, не терялись.
 * Снимок C10 является источником истины для своих элементов, а элементы из
 * текущего состояния, которых нет в снимке, сохраняются как realtime-приходы.
 */
export function mergeNotificationsById(
  snapshot: NotificationItem[],
  current: NotificationItem[]
): NotificationItem[] {
  const byId = new Map(snapshot.map((notification) => [notification.id, notification]));

  for (const notification of current) {
    if (!byId.has(notification.id)) {
      byId.set(notification.id, notification);
    }
  }

  return [...byId.values()].sort(compareNotificationsByCreatedAt);
}

export function countUnreadNotifications(notifications: NotificationItem[]) {
  return notifications.filter((notification) => notification.status === "new").length;
}

export function markNotificationReadById(
  notifications: NotificationItem[],
  notificationId: string
): NotificationItem[] {
  return notifications.map((notification) =>
    notification.id === notificationId
      ? {
          ...notification,
          status: "read"
        }
      : notification
  );
}

function compareMessagesByCreatedAt(left: Message, right: Message) {
  return left.createdAt.localeCompare(right.createdAt);
}

function compareConversationsByLastMessageAt(left: Conversation, right: Conversation) {
  return right.lastMessageAt.localeCompare(left.lastMessageAt);
}

function compareNotificationsByCreatedAt(left: NotificationItem, right: NotificationItem) {
  return right.createdAt.localeCompare(left.createdAt);
}
