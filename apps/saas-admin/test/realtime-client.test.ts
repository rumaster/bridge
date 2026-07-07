import { describe, expect, it } from "vitest";

import { createBrowserC7RealtimeClient } from "../src/api/client/realtime";

describe("SaaS Admin C7 realtime client", () => {
  it("reconnects with C7 resume cursors after a dropped browser socket", async () => {
    const sockets: FakeWebSocket[] = [];
    const statuses: string[] = [];
    const events: Array<{ eventId?: string; sequenceNumber: number }> = [];
    const realtime = createBrowserC7RealtimeClient({
      path: "/api/v1/ws",
      reconnectDelayMs: 1,
      WebSocketCtor: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });

    const connection = realtime.connect(
      (event) => events.push({ eventId: event.eventId, sequenceNumber: event.sequenceNumber }),
      (status) => {
        statuses.push(status);
      },
    );

    sockets[0]?.open();
    sockets[0]?.message({
      contract: "C7.WebSocketEvent",
      version: "1.0.0",
      event: "notification.created",
      event_id: "event-42",
      organization_id: "org-1",
      sequence_number: 42,
      occurred_at: "2026-07-07T08:00:00.000Z",
      payload: {
        notification: {
          contract: "C10.Notification",
          version: "1.0.0",
          id: "notif-42",
          organization_id: "org-1",
          recipient_user_id: "admin-1",
          category: "critical",
          title: "Realtime",
          body: "Проверка восстановления C7",
          payload: {},
          status: "new",
          channels: ["web"],
          created_at: "2026-07-07T08:00:00.000Z",
          read_at: null,
        },
      },
    });
    sockets[0]?.close();

    await wait(5);

    expect(events).toEqual([{ eventId: "event-42", sequenceNumber: 42 }]);
    expect(statuses).toContain("reconnecting");
    expect(sockets).toHaveLength(2);

    const reconnectUrl = new URL(sockets[1]!.url);
    expect(reconnectUrl.searchParams.get("last_event_id")).toBe("event-42");
    expect(reconnectUrl.searchParams.get("after_sequence_number")).toBe("42");

    connection.close();
  });
});

class FakeWebSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.emit("close", {});
  }

  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  open() {
    this.emit("open", {});
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
