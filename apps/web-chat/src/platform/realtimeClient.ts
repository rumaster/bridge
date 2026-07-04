import { normalizeMessage } from "./apiClient";
import type {
  C7WebSocketEvent,
  NormalizedWebChatRealtimeEvent,
  WebChatMessageStatus,
  WebChatWebSocketFactory,
  WebChatWebSocketLike,
} from "../types";

export type WebChatRealtimeClient = {
  start: () => void;
  stop: () => void;
};

export type WebChatRealtimeReconnectState = {
  afterSequenceNumber: number;
  lastEventId: string | null;
};

export type WebChatRealtimeClientOptions = {
  conversationId: string;
  initialSequenceNumber?: number;
  organizationId: string;
  reconnectDelayMs?: number;
  url: string;
  visitorSessionId?: string;
  webSocketFactory?: WebChatWebSocketFactory;
  onConnectionState?: (state: "connecting" | "online" | "reconnecting" | "offline") => void;
  onEvent: (event: NormalizedWebChatRealtimeEvent) => void;
  onReconnect?: (state: WebChatRealtimeReconnectState) => void | Promise<void>;
  onSequenceGap?: (state: {
    afterSequenceNumber: number;
    receivedSequenceNumber: number;
  }) => void | Promise<void>;
};

export function createWebChatRealtimeClient({
  conversationId,
  initialSequenceNumber = 0,
  organizationId,
  reconnectDelayMs = 1_000,
  url,
  visitorSessionId,
  webSocketFactory = defaultWebSocketFactory,
  onConnectionState,
  onEvent,
  onReconnect,
  onSequenceGap,
}: WebChatRealtimeClientOptions): WebChatRealtimeClient {
  let isStopped = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebChatWebSocketLike | null = null;
  let lastEventId: string | null = null;
  let lastSequenceNumber = normalizeInitialSequenceNumber(initialSequenceNumber);
  let hasConnectedOnce = false;
  const observedEventIds = new Set<string>();

  function start() {
    if (!isStopped) {
      return;
    }

    isStopped = false;
    connect();
  }

  function stop() {
    isStopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const currentSocket = socket;
    socket = null;
    currentSocket?.close();
    onConnectionState?.("offline");
  }

  function connect() {
    if (isStopped) {
      return;
    }

    onConnectionState?.(hasConnectedOnce ? "reconnecting" : "connecting");
    const nextSocket = webSocketFactory(
      buildRealtimeUrl(url, {
        conversationId,
        organizationId,
        visitorSessionId,
        lastEventId,
        afterSequenceNumber: lastSequenceNumber,
      }),
    );
    socket = nextSocket;

    nextSocket.onopen = () => {
      onConnectionState?.("online");
      sendSubscription(nextSocket);
      if (hasConnectedOnce) {
        void onReconnect?.({
          afterSequenceNumber: lastSequenceNumber,
          lastEventId,
        });
      }
      hasConnectedOnce = true;
    };

    nextSocket.onmessage = (messageEvent) => {
      const event = normalizeRealtimeEvent(messageEvent.data);
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

      if (
        typeof event.sequenceNumber === "number" &&
        lastSequenceNumber > 0 &&
        event.sequenceNumber > lastSequenceNumber + 1
      ) {
        void onSequenceGap?.({
          afterSequenceNumber: lastSequenceNumber,
          receivedSequenceNumber: event.sequenceNumber,
        });
      }

      if (typeof event.sequenceNumber === "number") {
        lastSequenceNumber = Math.max(lastSequenceNumber, event.sequenceNumber);
      }

      onEvent(event);
    };

    nextSocket.onerror = () => {
      onConnectionState?.("reconnecting");
    };

    nextSocket.onclose = () => {
      if (socket === nextSocket) {
        socket = null;
      }

      if (!isStopped) {
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }

    onConnectionState?.("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, Math.max(0, reconnectDelayMs));
  }

  function sendSubscription(nextSocket: WebChatWebSocketLike) {
    nextSocket.send(
      JSON.stringify({
        type: "subscribe",
        contract: "C7",
        channel: "web_chat",
        conversation_id: conversationId,
        organization_id: organizationId,
        visitor_session_id: visitorSessionId,
        last_event_id: lastEventId,
        after_sequence_number: lastSequenceNumber,
      }),
    );
  }

  return {
    start,
    stop,
  };
}

export function buildRealtimeUrl(
  baseUrl: string,
  {
    afterSequenceNumber,
    conversationId,
    lastEventId,
    organizationId,
    visitorSessionId,
  }: {
    afterSequenceNumber?: number;
    conversationId: string;
    lastEventId?: null | string;
    organizationId: string;
    visitorSessionId?: string;
  },
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("conversation_id", conversationId);
  url.searchParams.set("organization_id", organizationId);
  if (visitorSessionId) {
    url.searchParams.set("visitor_session_id", visitorSessionId);
  }
  if (lastEventId) {
    url.searchParams.set("last_event_id", lastEventId);
  }
  if (typeof afterSequenceNumber === "number" && afterSequenceNumber > 0) {
    url.searchParams.set("after_sequence_number", String(afterSequenceNumber));
  }

  return url.toString();
}

export function normalizeRealtimeEvent(
  rawValue: unknown,
): NormalizedWebChatRealtimeEvent | null {
  const parsedValue = typeof rawValue === "string" ? parseJson(rawValue) : rawValue;

  if (!isRecord(parsedValue)) {
    return null;
  }

  if (parsedValue.contract === "C7.WebSocketEvent") {
    return normalizeC7Event(parsedValue as C7WebSocketEvent);
  }

  const type = getString(parsedValue.type);
  const payload = parsedValue.payload;

  if (type === "message.created") {
    const message = safeNormalizeMessage(
      isRecord(payload) && isRecord(payload.message) ? payload.message : payload,
    );
    if (!message) {
      return null;
    }

    return {
      type,
      message,
    };
  }

  if (type === "message.status_changed" && isRecord(payload)) {
    const messageId = getString(payload.messageId) ?? getString(payload.id);
    const status = normalizeStatus(getString(payload.status));
    if (messageId && status) {
      return {
        type,
        messageId,
        status,
      };
    }
  }

  if ((type === "typing.started" || type === "typing.stopped") && isRecord(payload)) {
    const conversationId = getString(payload.conversationId) ?? getString(payload.conversation_id);
    if (conversationId) {
      return {
        type,
        conversationId,
        displayName: getString(payload.displayName) ?? getString(payload.display_name),
      };
    }
  }

  return null;
}

function normalizeC7Event(event: C7WebSocketEvent): NormalizedWebChatRealtimeEvent | null {
  const payload = event.payload;

  if (event.event === "message.created") {
    const message = safeNormalizeMessage(isRecord(payload.message) ? payload.message : payload);
    if (!message) {
      return null;
    }

    return {
      type: "message.created",
      eventId: event.event_id,
      sequenceNumber: event.sequence_number,
      message,
    };
  }

  if (event.event === "message.status_changed") {
    const messageId =
      getString(payload.messageId) ?? getString(payload.message_id) ?? getString(payload.id);
    const status = normalizeStatus(getString(payload.status));
    if (messageId && status) {
      return {
        type: "message.status_changed",
        eventId: event.event_id,
        sequenceNumber: event.sequence_number,
        messageId,
        status,
      };
    }
  }

  if (event.event === "typing.started" || event.event === "typing.stopped") {
    const conversationId =
      getString(payload.conversationId) ?? getString(payload.conversation_id);
    if (conversationId) {
      return {
        type: event.event,
        eventId: event.event_id,
        sequenceNumber: event.sequence_number,
        conversationId,
        displayName: getString(payload.displayName) ?? getString(payload.display_name),
      };
    }
  }

  return null;
}

export function resolveRealtimeUrl(apiBaseUrl: string | undefined, realtimeUrl: string | undefined) {
  if (realtimeUrl) {
    return realtimeUrl;
  }

  const origin = globalThis.location?.origin ?? "http://localhost";
  const apiUrl = new URL(apiBaseUrl ?? "/api/v1", origin);
  const wsUrl = new URL("ws", apiUrl.href.endsWith("/") ? apiUrl.href : `${apiUrl.href}/`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  return wsUrl.toString();
}

function defaultWebSocketFactory(url: string): WebChatWebSocketLike {
  if (typeof WebSocket !== "function") {
    throw new TypeError("WebSocket is unavailable in this environment");
  }

  return new WebSocket(url) as unknown as WebChatWebSocketLike;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeNormalizeMessage(value: unknown) {
  try {
    return normalizeMessage(value);
  } catch {
    return null;
  }
}

function normalizeInitialSequenceNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeStatus(value: string | undefined): WebChatMessageStatus | undefined {
  switch (value) {
    case "received":
    case "routed":
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
