import { describe, expect, it } from "vitest";
import {
  applyRealtimeEventToMessages,
  getLatestSequenceNumber,
  mergeWebChatMessages,
} from "../src/platform/messageState";
import type { NormalizedWebChatRealtimeEvent, WebChatMessage } from "../src/types";

describe("Bridge Web Chat M2 message state", () => {
  it("дедуплицирует message.created по message.id и сохраняет порядок sequence_number", () => {
    const first = message("message-1", 1, "Первое");
    const duplicateWithNewStatus = {
      ...first,
      status: "delivered",
    } satisfies WebChatMessage;
    const second = message("message-2", 2, "Второе");

    const result = mergeWebChatMessages([second], [first, duplicateWithNewStatus]);

    expect(result.map((item) => item.id)).toEqual(["message-1", "message-2"]);
    expect(result[0]?.status).toBe("delivered");
  });

  it("применяет message.status_changed без добавления дубля", () => {
    const result = applyRealtimeEventToMessages([message("message-1", 1, "Первое")], {
      type: "message.status_changed",
      messageId: "message-1",
      status: "read",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("read");
  });

  it("принимает AI message.created как обычное сообщение ленты", () => {
    const aiMessage = message("message-ai", 3, "AI ответ", "ai");
    const result = applyRealtimeEventToMessages([], {
      type: "message.created",
      message: aiMessage,
    } satisfies NormalizedWebChatRealtimeEvent);

    expect(result).toEqual([aiMessage]);
    expect(getLatestSequenceNumber(result)).toBe(3);
  });
});

function message(
  id: string,
  sequenceNumber: number,
  text: string,
  authorType: WebChatMessage["author"]["type"] = "visitor",
): WebChatMessage {
  return {
    id,
    organizationId: "org-1",
    conversationId: "conv-1",
    endpointId: "endpoint-1",
    channel: "web_chat",
    author: {
      type: authorType,
      displayName: authorType === "ai" ? "Bridge AI" : "Посетитель",
    },
    body: {
      type: "text",
      text,
    },
    createdAt: `2026-07-03T09:0${sequenceNumber}:00.000Z`,
    sequenceNumber,
    status: "sent",
  };
}
