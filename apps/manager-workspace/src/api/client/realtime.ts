import { mockC7Events } from "../mocks/fixtures";
import type { C7Event } from "./types";

export type RealtimeConnectionStatus = "connected" | "reconnecting" | "offline";

export interface RealtimeConnection {
  close: () => void;
}

export interface C7RealtimeClient {
  connect: (
    onEvent: (event: C7Event) => void,
    onStatus?: (status: RealtimeConnectionStatus) => void
  ) => RealtimeConnection;
  collectInitialEvents: () => Promise<C7Event[]>;
}

export function createMockC7RealtimeClient(events: C7Event[] = mockC7Events): C7RealtimeClient {
  return {
    connect(onEvent, onStatus) {
      let closed = false;
      onStatus?.("connected");

      const timers = events.map((event, index) =>
        globalThis.setTimeout(() => {
          if (!closed) {
            onEvent(event);
          }
        }, index * 10)
      );

      return {
        close() {
          closed = true;
          timers.forEach((timer) => globalThis.clearTimeout(timer));
          onStatus?.("offline");
        }
      };
    },
    async collectInitialEvents() {
      return [...events];
    }
  };
}
