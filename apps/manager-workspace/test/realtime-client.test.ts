import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createC7RealtimeClient } from "../src/api/client/realtime";

/**
 * Минимальный фейковый WebSocket: фиксирует URL, к которому подключился клиент,
 * и позволяет вручную эмитить события. Конструкторы копятся в `instances`, чтобы
 * тест мог проверить URL каждой попытки соединения (в т.ч. реконнектов).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly listeners: Record<string, Array<(event: unknown) => void>> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  close() {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000101";

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createC7RealtimeClient organization scope", () => {
  it("includes organization_id from a static option in the WS URL", () => {
    const client = createC7RealtimeClient({
      url: "https://workspace.local/api/v1/ws",
      organizationId: ORGANIZATION_ID,
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
    });

    const connection = client.connect(() => {});

    expect(FakeWebSocket.instances).toHaveLength(1);
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/v1/ws");
    expect(url.searchParams.get("organization_id")).toBe(ORGANIZATION_ID);

    connection.close();
  });

  it("resolves organization_id lazily from a function at open time", () => {
    let currentOrg: string | undefined;
    const client = createC7RealtimeClient({
      url: "https://workspace.local/api/v1/ws",
      organizationId: () => currentOrg,
      reconnectDelayMs: 5,
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
    });

    vi.useFakeTimers();
    const statuses: string[] = [];
    const connection = client.connect(() => {}, (status) => statuses.push(status));

    // До появления org сокет НЕ открывается (иначе сервер отклонит апгрейд 400),
    // клиент остаётся в reconnecting.
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(statuses.at(-1)).toBe("reconnecting");

    // org появился (после логина) — ближайший реконнект открывает сокет с org.
    currentOrg = ORGANIZATION_ID;
    vi.advanceTimersByTime(5);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).searchParams.get("organization_id")).toBe(
      ORGANIZATION_ID
    );

    connection.close();
  });

  it("carries last_event_id alongside organization_id after a reconnect", () => {
    vi.useFakeTimers();
    const client = createC7RealtimeClient({
      url: "https://workspace.local/api/v1/ws",
      organizationId: ORGANIZATION_ID,
      reconnectDelayMs: 5,
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
    });

    const connection = client.connect(() => {});
    const first = FakeWebSocket.instances[0];
    first.emit("open", {});
    first.emit("message", {
      data: JSON.stringify({
        contract: "C7.WebSocketEvent",
        event: "message.created",
        event_id: "message.created:msg-42",
        organization_id: ORGANIZATION_ID,
        sequence_number: 7,
        payload: { message: { id: "msg-42", conversationId: "conv-1" } }
      })
    });

    // Сервер закрыл сокет — клиент реконнектит, донося и org, и last_event_id.
    first.emit("close", {});
    vi.advanceTimersByTime(5);

    expect(FakeWebSocket.instances).toHaveLength(2);
    const reconnectUrl = new URL(FakeWebSocket.instances[1].url);
    expect(reconnectUrl.searchParams.get("organization_id")).toBe(ORGANIZATION_ID);
    expect(reconnectUrl.searchParams.get("last_event_id")).toBe("message.created:msg-42");

    connection.close();
  });
});
