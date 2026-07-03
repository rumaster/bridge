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
