import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateDialogList,
  aggregateDialogMessages,
  aggregateNotifications,
  buildDialogSummary,
  mapCategoryToSeverity,
  toMobileMessage,
  toMobileNotification,
} from "../../src/aggregators.js";

const conversation = {
  id: "conversation-1",
  organization_id: "org-1",
  client_id: "client-1",
  created_at: "2026-07-04T12:00:00.000Z",
  updated_at: "2026-07-04T12:00:03.000Z",
};

const client = { id: "client-1", organization_id: "org-1", display_name: "Ada Customer" };

const messages = [
  {
    id: "message-1",
    conversation_id: "conversation-1",
    sender_type: "manager",
    text: "Hello, how can I help?",
    sequence_number: 1,
    status: "sent",
    occurred_at: "2026-07-04T12:00:01.000Z",
  },
  {
    id: "message-2",
    conversation_id: "conversation-1",
    sender_type: "client",
    text: "Can I change the delivery time?",
    sequence_number: 2,
    status: "received",
    occurred_at: "2026-07-04T12:00:03.000Z",
  },
  {
    id: "message-3",
    conversation_id: "conversation-1",
    sender_type: "client",
    text: "Already read this one",
    sequence_number: 3,
    status: "read",
    occurred_at: "2026-07-04T12:00:02.000Z",
  },
];

describe("SVC-MOB aggregators (C3.* → MOBILE.v1 DTO)", () => {
  it("maps C10 category to mobile severity", () => {
    assert.equal(mapCategoryToSeverity("critical"), "critical");
    assert.equal(mapCategoryToSeverity("error"), "critical");
    assert.equal(mapCategoryToSeverity("warning"), "warning");
    assert.equal(mapCategoryToSeverity("admin"), "warning");
    assert.equal(mapCategoryToSeverity("info"), "info");
    assert.equal(mapCategoryToSeverity("anything-else"), "info");
  });

  it("builds a dialog summary with last message and unread counter", () => {
    const summary = buildDialogSummary({ conversation, messages, client });

    assert.equal(summary.dialog_id, "conversation-1");
    assert.equal(summary.conversation_id, "conversation-1");
    assert.equal(summary.organization_id, "org-1");
    assert.deepEqual(summary.client, { client_id: "client-1", display_name: "Ada Customer" });
    // last_message — самое свежее по sequence_number (message-3), не по времени
    assert.equal(summary.last_message.message_id, "message-3");
    // unread_count — клиентские сообщения не в read/seen (только message-2)
    assert.equal(summary.unread_count, 1);
  });

  it("counts no unread when the client has no pending messages", () => {
    const readOnly = messages.map((message) =>
      message.sender_type === "client" ? { ...message, status: "read" } : message,
    );
    const summary = buildDialogSummary({ conversation, messages: readOnly, client });
    assert.equal(summary.unread_count, 0);
  });

  it("falls back to an empty preview for a conversation without messages", () => {
    const summary = buildDialogSummary({ conversation, messages: [], client });
    assert.equal(summary.last_message.sender_type, "system");
    assert.equal(summary.last_message.text, "");
    assert.equal(summary.unread_count, 0);
  });

  it("orders dialog history strictly by sequence_number and sets dialog_id", () => {
    const shuffled = [messages[2], messages[0], messages[1]];
    const history = aggregateDialogMessages({ messages: shuffled });

    assert.deepEqual(
      history.map((message) => message.sequence_number),
      [1, 2, 3],
    );
    for (const message of history) {
      assert.equal(message.dialog_id, "conversation-1");
      assert.equal(message.conversation_id, "conversation-1");
    }
  });

  it("normalizes unknown sender types to system", () => {
    const mapped = toMobileMessage({
      id: "message-x",
      conversation_id: "conversation-1",
      sender_type: "bot-9000",
      text: "hi",
      sequence_number: 1,
      status: "sent",
      occurred_at: "2026-07-04T12:00:01.000Z",
    });
    assert.equal(mapped.sender_type, "system");
  });

  it("sorts newest dialogs first", () => {
    const older = { ...conversation, id: "conversation-0", updated_at: "2026-07-04T11:00:00.000Z" };
    const dialogs = aggregateDialogList({
      conversations: [older, conversation],
      messagesByConversation: new Map([
        ["conversation-0", []],
        ["conversation-1", messages],
      ]),
      clientsById: new Map([["client-1", client]]),
    });
    assert.deepEqual(
      dialogs.map((dialog) => dialog.dialog_id),
      ["conversation-1", "conversation-0"],
    );
  });

  it("maps a C10 notification into the mobile notification DTO", () => {
    const mobile = toMobileNotification({
      id: "notification-1",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "critical",
      title: "Escalation",
      body: "A client is waiting",
      payload: { conversation_id: "conversation-1" },
      status: "new",
      created_at: "2026-07-04T12:00:00.000Z",
      read_at: null,
    });

    assert.equal(mobile.notification_id, "notification-1");
    assert.equal(mobile.user_id, "manager-1");
    assert.equal(mobile.severity, "critical");
    assert.deepEqual(mobile.data, { conversation_id: "conversation-1" });
    assert.equal(mobile.read_at, null);
  });

  it("derives read_at from a read status when absent", () => {
    const mobile = toMobileNotification({
      id: "notification-2",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      category: "info",
      title: "Seen",
      body: "",
      payload: {},
      status: "read",
      created_at: "2026-07-04T12:00:00.000Z",
      read_at: null,
    });
    assert.equal(mobile.read_at, "2026-07-04T12:00:00.000Z");
  });

  it("sorts notifications newest first", () => {
    const feed = aggregateNotifications({
      notifications: [
        {
          id: "n-old",
          organization_id: "org-1",
          recipient_user_id: "manager-1",
          category: "info",
          title: "old",
          body: "",
          payload: {},
          status: "new",
          created_at: "2026-07-04T11:00:00.000Z",
          read_at: null,
        },
        {
          id: "n-new",
          organization_id: "org-1",
          recipient_user_id: "manager-1",
          category: "info",
          title: "new",
          body: "",
          payload: {},
          status: "new",
          created_at: "2026-07-04T13:00:00.000Z",
          read_at: null,
        },
      ],
    });
    assert.deepEqual(
      feed.map((notification) => notification.notification_id),
      ["n-new", "n-old"],
    );
  });
});
