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

export interface C7RealtimeClientOptions {
  url?: string;
  reconnectDelayMs?: number;
  WebSocketCtor?: typeof WebSocket;
  /**
   * organization_id арендатора для scope C7-подписки. WS-сервер App-стороны
   * фильтрует события по organization_id (изоляция тенантов, WG-9): подписка БЕЗ
   * organization_id не матчит НИ ОДНОГО события, поэтому его обязательно нести в
   * WS-URL. Передаётся как значение или как резолвер (читается заново при каждом
   * (пере)открытии сокета) — так появление/смена org после логина подхватывается
   * на ближайшем реконнекте без пересоздания клиента.
   */
  organizationId?: string | (() => string | undefined);
}

const DEFAULT_WS_PATH = "/api/v1/ws";
const DEFAULT_RECONNECT_DELAY_MS = 250;

export function createC7RealtimeClient(options: C7RealtimeClientOptions = {}): C7RealtimeClient {
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  return {
    connect(onEvent, onStatus) {
      const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;

      if (!WebSocketCtor) {
        onStatus?.("offline");
        return {
          close() {
            onStatus?.("offline");
          }
        };
      }

      let closed = false;
      let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      let socket: WebSocket | null = null;
      let lastEventId: string | null = null;

      function openSocket() {
        if (closed) {
          return;
        }

        // organization_id резолвим на КАЖДОМ открытии сокета: до логина его ещё
        // нет — тогда не открываем заведомо отклоняемый (400) сокет, а уходим в
        // reconnecting и повторяем; после логина ближайшая попытка подхватит org.
        const organizationId = resolveOrganizationId(options.organizationId);
        if (!organizationId) {
          scheduleReconnect();
          return;
        }

        onStatus?.("reconnecting");
        socket = new WebSocketCtor(
          resolveC7WebSocketUrl(options.url ?? DEFAULT_WS_PATH, lastEventId, organizationId)
        );

        socket.addEventListener("open", () => {
          onStatus?.("connected");
        });

        socket.addEventListener("message", (message) => {
          const event = parseC7Event(message.data);

          if (!event) {
            return;
          }

          lastEventId = event.event_id;
          onEvent(event);
        });

        socket.addEventListener("close", scheduleReconnect);
        socket.addEventListener("error", () => {
          socket?.close();
        });
      }

      function scheduleReconnect() {
        if (closed) {
          onStatus?.("offline");
          return;
        }

        onStatus?.("reconnecting");
        reconnectTimer = globalThis.setTimeout(openSocket, reconnectDelayMs);
      }

      openSocket();

      return {
        close() {
          closed = true;

          if (reconnectTimer) {
            globalThis.clearTimeout(reconnectTimer);
          }

          socket?.close();
          onStatus?.("offline");
        }
      };
    },
    async collectInitialEvents() {
      return [];
    }
  };
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

function parseC7Event(data: unknown): C7Event | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as C7Event;
    return parsed?.contract === "C7.WebSocketEvent" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveC7WebSocketUrl(
  pathOrUrl: string,
  lastEventId: string | null,
  organizationId: string
) {
  const base = globalThis.location?.href ?? "http://localhost";
  const url = new URL(pathOrUrl, base);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  // organization_id — scope тенанта: без него WS-сервер отклонит апгрейд (WG-9).
  url.searchParams.set("organization_id", organizationId);

  if (lastEventId) {
    url.searchParams.set("last_event_id", lastEventId);
  }

  return url.toString();
}

function resolveOrganizationId(
  source: string | (() => string | undefined) | undefined
): string | undefined {
  const value = typeof source === "function" ? source() : source;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
