import { describe, expect, it } from "vitest";

import type { C7Event, ClientProfile, Conversation, Message } from "../src/api/client/types";
import {
  advanceC7Sequence,
  applyC7EventToClients,
  applyC7EventToConversations,
  applyC7EventToMessages,
  applyC7EventToTypingClientIds,
  isC7SequenceGap,
  markC7EventSeen,
  mergeMessagesById
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
