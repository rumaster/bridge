import { describe, expect, it } from "vitest";

import type {
  C7Event,
  ClientProfile,
  Conversation,
  Message,
  NotificationItem
} from "../src/api/client/types";
import {
  advanceC7Sequence,
  applyC7EventToClients,
  applyC7EventToConversations,
  applyC7EventToMessages,
  applyC7EventToNotifications,
  applyC7EventToTypingClientIds,
  countUnreadNotifications,
  isC7SequenceGap,
  markC7EventSeen,
  markNotificationReadById,
  mergeMessagesById,
  mergeNotificationsById,
  sortNotificationsByCreatedAt
} from "../src/state/realtime-merge";

const baseMessage: Message = {
  id: "msg-live-1",
  conversationId: "conv-1",
  channel: "web_chat",
  direction: "inbound",
  senderType: "client",
  content: "Есть обновления по заказу?",
  status: "received",
  createdAt: "2026-07-02T16:11:00.000Z"
};

const baseConversation: Conversation = {
  id: "conv-1",
  clientId: "client-1",
  status: "open",
  channel: "web_chat",
  lastMessageAt: "2026-07-02T16:10:00.000Z",
  lastMessagePreview: "Хочу уточнить статус заказа",
  unreadCount: 2
};

function createEvent(
  event: C7Event["event"],
  sequenceNumber: number,
  payload: C7Event["payload"]
): C7Event {
  return {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event,
    event_id: `event-${sequenceNumber}`,
    organization_id: "org-1",
    sequence_number: sequenceNumber,
    payload,
    occurred_at: "2026-07-02T16:11:00.000Z"
  } as C7Event;
}

describe("Manager Workspace C7 realtime merge", () => {
  it("deduplicates live message.created events by message.id", () => {
    const messageCreated = createEvent("message.created", 1001, {
      message: baseMessage
    });

    const once = applyC7EventToMessages([], messageCreated);
    const twice = applyC7EventToMessages(once, {
      ...messageCreated,
      event_id: "event-duplicate-redelivery"
    });

    expect(twice).toHaveLength(1);
    expect(twice[0]).toEqual(baseMessage);
  });

  it("updates message statuses, conversation previews and typing state from C7 events", () => {
    const messageCreated = createEvent("message.created", 1001, {
      message: baseMessage
    });
    const statusChanged = createEvent("message.status_changed", 1002, {
      message_id: baseMessage.id,
      conversation_id: baseMessage.conversationId,
      status: "delivered"
    });
    const typingStarted = createEvent("typing.started", 1003, {
      conversation_id: "conv-1",
      client_id: "client-1"
    });

    const messages = applyC7EventToMessages([baseMessage], statusChanged);
    const conversations = applyC7EventToConversations([baseConversation], messageCreated, new Set());
    const typing = applyC7EventToTypingClientIds([], typingStarted, "conv-1");

    expect(messages[0]?.status).toBe("delivered");
    expect(conversations[0]?.lastMessagePreview).toBe(baseMessage.content);
    expect(conversations[0]?.unreadCount).toBe(3);
    expect(typing).toEqual(["client-1"]);
  });

  it("coerces object content from live message.created events into a renderable string", () => {
    // Ядро шлёт content ОБЪЕКТОМ ({type,text} или {text,subject} для email).
    // Рендер {message.content} падал бы с React error #31, поэтому realtime-путь
    // обязан привести content к строке (как REST-нормализатор).
    const textEvent = createEvent("message.created", 2001, {
      message: {
        ...baseMessage,
        content: { type: "text", text: "Здравствуйте, есть вопрос" } as unknown as string
      }
    });
    const emailEvent = createEvent("message.created", 2002, {
      message: {
        ...baseMessage,
        id: "msg-live-2",
        conversationId: "conv-1",
        content: { text: "Тело письма", subject: "Тема" } as unknown as string
      }
    });

    const messages = applyC7EventToMessages([], textEvent);
    expect(messages[0]?.content).toBe("Здравствуйте, есть вопрос");
    expect(typeof messages[0]?.content).toBe("string");

    const emailMessages = applyC7EventToMessages([], emailEvent);
    expect(emailMessages[0]?.content).toBe("Тело письма");

    // Превью диалога тоже должно быть строкой (иначе крешит очередь диалогов).
    const conversations = applyC7EventToConversations([baseConversation], textEvent, new Set());
    expect(conversations[0]?.lastMessagePreview).toBe("Здравствуйте, есть вопрос");
    expect(typeof conversations[0]?.lastMessagePreview).toBe("string");
  });

  it("tracks event_id redelivery and sequence gaps for reconnect catch-up", () => {
    const seenEventIds = new Set<string>();
    const firstEvent = createEvent("message.created", 10, {
      message: baseMessage
    });
    const gapEvent = createEvent("typing.stopped", 13, {
      conversation_id: "conv-1",
      client_id: "client-1"
    });

    expect(markC7EventSeen(seenEventIds, firstEvent)).toBe(true);
    expect(markC7EventSeen(seenEventIds, firstEvent)).toBe(false);
    expect(isC7SequenceGap(advanceC7Sequence(null, firstEvent), gapEvent.sequence_number)).toBe(true);
  });

  it("does not increment conversation unread twice for the same C7 message.id", () => {
    const seenMessageIds = new Set<string>();
    const messageCreated = createEvent("message.created", 1001, {
      message: baseMessage
    });
    const afterFirstDelivery = applyC7EventToConversations(
      [baseConversation],
      messageCreated,
      seenMessageIds
    );
    const afterDuplicateDelivery = applyC7EventToConversations(
      afterFirstDelivery,
      {
        ...messageCreated,
        event_id: "event-redelivered-with-new-id"
      },
      seenMessageIds
    );

    expect(afterFirstDelivery[0]?.unreadCount).toBe(3);
    expect(afterDuplicateDelivery[0]?.unreadCount).toBe(3);
  });

  it("merges refetched messages without duplicating already observed realtime messages", () => {
    const refetchedMessage = {
      ...baseMessage,
      status: "delivered" as const
    };

    expect(mergeMessagesById([baseMessage], [refetchedMessage])).toEqual([refetchedMessage]);
  });

  it("keeps a realtime terminal status when a stale catch-up snapshot arrives", () => {
    const deliveredMessage = {
      ...baseMessage,
      status: "delivered" as const
    };
    const staleSnapshotMessage = {
      ...baseMessage,
      status: "sent" as const
    };

    expect(mergeMessagesById([deliveredMessage], [staleSnapshotMessage])[0]?.status).toBe("delivered");
  });

  it("prepends and deduplicates realtime notification.created events by notification.id", () => {
    const existing: NotificationItem[] = [
      {
        id: "notif-1",
        category: "info",
        title: "Новый диалог в очереди",
        body: "Клиент ожидает ответа.",
        status: "new",
        createdAt: "2026-07-02T16:10:05.000Z"
      }
    ];
    const liveNotification: NotificationItem = {
      id: "notif-live-1",
      category: "critical",
      title: "Критический сбой канала",
      body: "Доставка приостановлена.",
      status: "new",
      createdAt: "2026-07-02T16:11:12.000Z"
    };
    const created = createEvent("notification.created", 1006, {
      notification: liveNotification
    });

    const afterFirst = applyC7EventToNotifications(existing, created);
    const afterDuplicate = applyC7EventToNotifications(afterFirst, {
      ...created,
      event_id: "notification-redelivered"
    });

    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]?.id).toBe("notif-live-1");
    expect(afterDuplicate).toHaveLength(2);
  });

  it("counts unread notifications and marks a single notification read by id", () => {
    const notifications: NotificationItem[] = [
      {
        id: "notif-1",
        category: "info",
        title: "Первое",
        body: "…",
        status: "new",
        createdAt: "2026-07-02T16:10:05.000Z"
      },
      {
        id: "notif-2",
        category: "warning",
        title: "Второе",
        body: "…",
        status: "new",
        createdAt: "2026-07-02T15:55:00.000Z"
      }
    ];

    expect(countUnreadNotifications(notifications)).toBe(2);

    const afterRead = markNotificationReadById(notifications, "notif-1");
    expect(afterRead.find((item) => item.id === "notif-1")?.status).toBe("read");
    expect(countUnreadNotifications(afterRead)).toBe(1);
  });

  it("sorts notifications by createdAt descending without mutating the input", () => {
    const notifications: NotificationItem[] = [
      {
        id: "notif-old",
        category: "info",
        title: "Старое",
        body: "…",
        status: "read",
        createdAt: "2026-07-02T15:00:00.000Z"
      },
      {
        id: "notif-new",
        category: "critical",
        title: "Новое",
        body: "…",
        status: "new",
        createdAt: "2026-07-02T16:30:00.000Z"
      }
    ];

    const sorted = sortNotificationsByCreatedAt(notifications);
    expect(sorted.map((item) => item.id)).toEqual(["notif-new", "notif-old"]);
    expect(notifications.map((item) => item.id)).toEqual(["notif-old", "notif-new"]);
  });

  it("preserves realtime notifications that arrived before the C10 snapshot resolved", () => {
    const liveNotification: NotificationItem = {
      id: "notif-live-1",
      category: "critical",
      title: "Критический сбой канала",
      body: "Доставка приостановлена.",
      status: "new",
      createdAt: "2026-07-02T16:11:12.000Z"
    };
    const snapshot: NotificationItem[] = [
      {
        id: "notif-1",
        category: "info",
        title: "Новый диалог в очереди",
        body: "Клиент ожидает ответа.",
        status: "new",
        createdAt: "2026-07-02T16:10:05.000Z"
      }
    ];

    const merged = mergeNotificationsById(snapshot, [liveNotification]);
    expect(merged.map((item) => item.id)).toEqual(["notif-live-1", "notif-1"]);

    // Снимок C10 является источником истины для своих элементов.
    const readInSnapshot: NotificationItem[] = [{ ...snapshot[0]!, status: "read" }];
    const mergedWithSnapshotPriority = mergeNotificationsById(readInSnapshot, snapshot);
    expect(mergedWithSnapshotPriority.find((item) => item.id === "notif-1")?.status).toBe("read");
  });

  it("applies client.status_changed to the client card projection", () => {
    const clients: ClientProfile[] = [
      {
        id: "client-1",
        displayName: "Анна Петрова",
        tags: [],
        notes: [],
        endpoints: []
      }
    ];
    const statusChanged = createEvent("client.status_changed", 1001, {
      client_id: "client-1",
      status: "online"
    });

    expect(applyC7EventToClients(clients, statusChanged)[0]?.status).toBe("online");
  });
});
