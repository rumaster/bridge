import { describe, expect, it } from "vitest";
import { createWebChatRealtimeClient } from "../src/platform/realtimeClient";

describe("Bridge Web Chat C7 realtime client", () => {
  it("после reconnect передает last_event_id и after_sequence_number для докрутки", async () => {
    const sockets: FakeWebSocket[] = [];
    const reconnects: Array<{
      afterSequenceNumber: number;
      lastEventId: string | null;
    }> = [];
    const client = createWebChatRealtimeClient({
      conversationId: "conv-1",
      organizationId: "org-1",
      reconnectDelayMs: 1,
      url: "ws://localhost/api/v1/ws",
      webSocketFactory(url) {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      onEvent() {},
      onReconnect(state) {
        reconnects.push(state);
      },
    });

    client.start();
    sockets[0]?.open();
    sockets[0]?.emit({
      contract: "C7.WebSocketEvent",
      version: "1.0.0",
      event: "message.created",
      event_id: "event-3",
      organization_id: "org-1",
      sequence_number: 3,
      occurred_at: "2026-07-03T09:03:00.000Z",
      payload: {
        message: {
          id: "message-3",
          organizationId: "org-1",
          conversationId: "conv-1",
          channel: "web_chat",
          author: {
            type: "manager",
            displayName: "Менеджер",
          },
          body: {
            type: "text",
            text: "Третье",
          },
          createdAt: "2026-07-03T09:03:00.000Z",
          sequenceNumber: 3,
          status: "sent",
        },
      },
    });

    sockets[0]?.close();
    await wait(5);
    sockets[1]?.open();

    expect(reconnects).toEqual([
      {
        afterSequenceNumber: 3,
        lastEventId: "event-3",
      },
    ]);
    expect(sockets[1]?.url).toBe(
      "ws://localhost/api/v1/ws?conversation_id=conv-1&organization_id=org-1&last_event_id=event-3&after_sequence_number=3",
    );

    client.stop();
  });

  it("детектирует первый sequence gap относительно уже загруженной истории", () => {
    const sockets: FakeWebSocket[] = [];
    const gaps: Array<{
      afterSequenceNumber: number;
      receivedSequenceNumber: number;
    }> = [];
    const events: string[] = [];
    const client = createWebChatRealtimeClient({
      conversationId: "conv-1",
      initialSequenceNumber: 2,
      organizationId: "org-1",
      url: "ws://localhost/api/v1/ws",
      webSocketFactory(url) {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      onEvent(event) {
        if (event.type === "message.created") {
          events.push(event.message.id);
        }
      },
      onSequenceGap(state) {
        gaps.push(state);
      },
    });

    client.start();
    expect(sockets[0]?.url).toBe(
      "ws://localhost/api/v1/ws?conversation_id=conv-1&organization_id=org-1&after_sequence_number=2",
    );
    sockets[0]?.open();
    sockets[0]?.emit(c7MessageEvent("event-4", "message-4", 4, "Четвертое"));

    expect(gaps).toEqual([
      {
        afterSequenceNumber: 2,
        receivedSequenceNumber: 4,
      },
    ]);
    expect(events).toEqual(["message-4"]);

    client.stop();
  });

  it("не применяет replay дубля после частых reconnect", async () => {
    const sockets: FakeWebSocket[] = [];
    const events: string[] = [];
    const reconnects: number[] = [];
    const client = createWebChatRealtimeClient({
      conversationId: "conv-1",
      initialSequenceNumber: 1,
      organizationId: "org-1",
      reconnectDelayMs: 1,
      url: "ws://localhost/api/v1/ws",
      webSocketFactory(url) {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      onEvent(event) {
        if (event.type === "message.created") {
          events.push(event.message.id);
        }
      },
      onReconnect({ afterSequenceNumber }) {
        reconnects.push(afterSequenceNumber);
      },
    });

    client.start();
    sockets[0]?.open();
    sockets[0]?.emit(c7MessageEvent("event-2", "message-2", 2, "Второе"));

    sockets[0]?.close();
    await wait(5);
    sockets[1]?.open();
    sockets[1]?.emit(c7MessageEvent("event-2", "message-2", 2, "Второе replay"));
    sockets[1]?.close();
    await wait(5);
    sockets[2]?.open();
    sockets[2]?.emit(c7MessageEvent("event-3", "message-3", 3, "Третье"));

    expect(events).toEqual(["message-2", "message-3"]);
    expect(reconnects).toEqual([2, 2]);
    expect(sockets[2]?.url).toBe(
      "ws://localhost/api/v1/ws?conversation_id=conv-1&organization_id=org-1&last_event_id=event-2&after_sequence_number=2",
    );

    client.stop();
  });
});

class FakeWebSocket {
  onclose: null | ((event: unknown) => void) = null;
  onerror: null | ((event: unknown) => void) = null;
  onmessage: null | ((event: { data: unknown }) => void) = null;
  onopen: null | ((event: unknown) => void) = null;

  constructor(readonly url: string) {}

  close() {
    this.onclose?.(undefined);
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  open() {
    this.onopen?.(undefined);
  }

  send() {}
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function c7MessageEvent(
  eventId: string,
  messageId: string,
  sequenceNumber: number,
  text: string,
) {
  return {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "message.created",
    event_id: eventId,
    organization_id: "org-1",
    sequence_number: sequenceNumber,
    occurred_at: `2026-07-03T09:0${sequenceNumber}:00.000Z`,
    payload: {
      message: {
        id: messageId,
        organizationId: "org-1",
        conversationId: "conv-1",
        channel: "web_chat",
        author: {
          type: "manager",
          displayName: "Менеджер",
        },
        body: {
          type: "text",
          text,
        },
        createdAt: `2026-07-03T09:0${sequenceNumber}:00.000Z`,
        sequenceNumber,
        status: "sent",
      },
    },
  };
}
