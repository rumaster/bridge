import { mockC7Events } from "../mocks/fixtures";
import type { C7Event, ChannelErrorLogItem, ChannelStatus } from "./types";

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
        }, (index + 1) * 20)
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

export function createBrowserC7RealtimeClient(path = "/api/v1/ws"): C7RealtimeClient {
  return {
    connect(onEvent, onStatus) {
      if (typeof WebSocket === "undefined") {
        onStatus?.("offline");
        return {
          close() {}
        };
      }

      const url = toWebSocketUrl(path);
      const socket = new WebSocket(url);

      socket.addEventListener("open", () => onStatus?.("connected"));
      socket.addEventListener("close", () => onStatus?.("offline"));
      socket.addEventListener("error", () => onStatus?.("reconnecting"));
      socket.addEventListener("message", (message) => {
        const event = parseC7Envelope(message.data);
        if (event) {
          onEvent(event);
        }
      });

      return {
        close() {
          socket.close();
        }
      };
    },
    async collectInitialEvents() {
      return [];
    }
  };
}

function toWebSocketUrl(path: string) {
  if (/^wss?:\/\//.test(path)) {
    return path;
  }

  const origin = globalThis.location?.origin ?? "http://localhost";
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseC7Envelope(data: unknown): C7Event | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const envelope = JSON.parse(data) as {
      event?: string;
      sequence_number?: number;
      payload?: {
        channel_id?: string;
        channelId?: string;
        status?: ChannelStatus;
        last_check_at?: string;
        lastCheckAt?: string;
        error?: ChannelErrorLogItem | null;
      };
    };

    const payload = envelope.payload;
    const channelId = payload?.channel_id ?? payload?.channelId;
    if (envelope.event !== "channel.status_changed" || !payload || !channelId) {
      return null;
    }

    return {
      type: "channel.status_changed",
      sequenceNumber: envelope.sequence_number ?? 0,
      payload: {
        channelId,
        status: payload.status ?? "disabled",
        lastCheckAt: payload.last_check_at ?? payload.lastCheckAt,
        error: payload.error
      }
    };
  } catch {
    return null;
  }
}
