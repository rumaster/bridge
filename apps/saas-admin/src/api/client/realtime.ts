import { mockC7Events } from "../mocks/fixtures";
import type {
  BroadcastStats,
  BroadcastStatus,
  C7Event,
  ChannelErrorLogItem,
  ChannelStatus,
  Notification
} from "./types";

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

export interface BrowserC7RealtimeClientOptions {
  path?: string;
  reconnectDelayMs?: number;
  WebSocketCtor?: typeof WebSocket;
}

const DEFAULT_WS_PATH = "/api/v1/ws";
const DEFAULT_RECONNECT_DELAY_MS = 250;

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

export function createBrowserC7RealtimeClient(
  options: string | BrowserC7RealtimeClientOptions = {},
): C7RealtimeClient {
  const resolvedOptions = typeof options === "string" ? { path: options } : options;
  const path = resolvedOptions.path ?? DEFAULT_WS_PATH;
  const reconnectDelayMs = resolvedOptions.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  return {
    connect(onEvent, onStatus) {
      const WebSocketCtor = resolvedOptions.WebSocketCtor ?? globalThis.WebSocket;

      if (!WebSocketCtor) {
        onStatus?.("offline");
        return {
          close() {}
        };
      }

      let closed = false;
      let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      let socket: WebSocket | null = null;
      let lastEventId: string | null = null;
      let lastSequenceNumber = 0;
      const observedEventIds = new Set<string>();

      function openSocket() {
        if (closed) {
          return;
        }

        onStatus?.("reconnecting");
        const nextSocket = new WebSocketCtor(
          toWebSocketUrl(path, {
            afterSequenceNumber: lastSequenceNumber,
            lastEventId
          })
        );
        socket = nextSocket;

        nextSocket.addEventListener("open", () => onStatus?.("connected"));
        nextSocket.addEventListener("close", () => {
          if (socket === nextSocket) {
            socket = null;
          }
          scheduleReconnect();
        });
        nextSocket.addEventListener("error", () => {
          onStatus?.("reconnecting");
          nextSocket.close();
        });
        nextSocket.addEventListener("message", (message) => {
          const event = parseC7Envelope(message.data);
          if (!event) {
            return;
          }

          if (event.eventId) {
            if (observedEventIds.has(event.eventId)) {
              return;
            }
            observedEventIds.add(event.eventId);
            lastEventId = event.eventId;
          }

          lastSequenceNumber = Math.max(lastSequenceNumber, event.sequenceNumber);
          onEvent(event);
        });
      }

      function scheduleReconnect() {
        if (closed) {
          onStatus?.("offline");
          return;
        }

        if (reconnectTimer) {
          return;
        }

        onStatus?.("reconnecting");
        reconnectTimer = globalThis.setTimeout(() => {
          reconnectTimer = null;
          openSocket();
        }, Math.max(0, reconnectDelayMs));
      }

      openSocket();

      return {
        close() {
          closed = true;
          if (reconnectTimer) {
            globalThis.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }

          const currentSocket = socket;
          socket = null;
          currentSocket?.close();
          onStatus?.("offline");
        }
      };
    },
    async collectInitialEvents() {
      return [];
    }
  };
}

function toWebSocketUrl(
  path: string,
  {
    afterSequenceNumber,
    lastEventId
  }: {
    afterSequenceNumber: number;
    lastEventId: string | null;
  }
) {
  if (/^wss?:\/\//.test(path)) {
    const url = new URL(path);
    applyResumeCursor(url, { afterSequenceNumber, lastEventId });
    return url.toString();
  }

  const origin = globalThis.location?.origin ?? "http://localhost";
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  applyResumeCursor(url, { afterSequenceNumber, lastEventId });
  return url.toString();
}

function applyResumeCursor(
  url: URL,
  {
    afterSequenceNumber,
    lastEventId
  }: {
    afterSequenceNumber: number;
    lastEventId: string | null;
  }
) {
  if (lastEventId) {
    url.searchParams.set("last_event_id", lastEventId);
  }

  if (afterSequenceNumber > 0) {
    url.searchParams.set("after_sequence_number", String(afterSequenceNumber));
  }
}

function parseC7Envelope(data: unknown): C7Event | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const envelope = JSON.parse(data) as {
      event?: string;
      event_id?: string;
      sequence_number?: number;
      payload?: {
        channel_id?: string;
        channelId?: string;
        status?: ChannelStatus | BroadcastStatus;
        last_check_at?: string;
        lastCheckAt?: string;
        error?: ChannelErrorLogItem | null;
        broadcast_id?: string;
        broadcastId?: string;
        stats?: BroadcastStats;
        notification?: Notification;
      };
    };

    const eventId = typeof envelope.event_id === "string" ? envelope.event_id : undefined;
    const payload = envelope.payload;
    const sequenceNumber = envelope.sequence_number ?? 0;
    if (!payload) {
      return null;
    }

    if (envelope.event === "channel.status_changed") {
      const channelId = payload.channel_id ?? payload.channelId;
      if (!channelId) {
        return null;
      }

      return {
        type: "channel.status_changed",
        eventId,
        sequenceNumber,
        payload: {
          channelId,
          status: (payload.status as ChannelStatus) ?? "disabled",
          lastCheckAt: payload.last_check_at ?? payload.lastCheckAt,
          error: payload.error
        }
      };
    }

    if (envelope.event === "broadcast.state_changed") {
      const broadcastId = payload.broadcast_id ?? payload.broadcastId;
      if (!broadcastId || !payload.status) {
        return null;
      }

      return {
        type: "broadcast.state_changed",
        eventId,
        sequenceNumber,
        payload: {
          broadcastId,
          status: payload.status as BroadcastStatus,
          stats: payload.stats
        }
      };
    }

    if (envelope.event === "notification.created") {
      if (!payload.notification) {
        return null;
      }

      return {
        type: "notification.created",
        eventId,
        sequenceNumber,
        payload: {
          notification: payload.notification
        }
      };
    }

    return null;
  } catch {
    return null;
  }
}
