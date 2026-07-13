import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import {
  C7_RECONNECT_SEMANTICS,
  C7_WS_PATH,
} from "../../../packages/contracts/src/c7.js";
import { renderEdgeMetrics } from "./edge-metrics.js";
import {
  EdgeTunnelMockValidationError,
  createMockEdgeTunnel,
} from "./mock-tunnel.js";
import {
  WebSocketChannelMockValidationError,
  createMockWebSocketChannel,
} from "./mock-ws-channel.js";
import {
  WS_OPCODE,
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
} from "./ws-frame.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_KEEPALIVE_INTERVAL_MS = 30_000;

export interface CreateEdgeGatewayServerOptions {
  core?: any;
  tunnel?: any;
  wsChannel?: any;
  edgeCluster?: any;
  vpnTunnel?: any;
  /** Control-plane App→Edge (creds-sync + egress_dispatch), Этап M5. */
  controlPlane?: { handle(message: unknown): Promise<any> };
  liveness?: { isUp(): boolean; lastProbeAt(): number | null } | null;
  /**
   * База ядра (App) для прозрачного edge-транзита REST Web Chat (W2). Если задана —
   * запросы `/api/v1/web-chat/*` синхронно проксируются в ядро поверх сетевого
   * VPN-туннеля (AmneziaWG). Без неё маршрут отдаёт прежний 404 (проброс выключен).
   */
  webChatBackendUrl?: string;
  /**
   * Признак, что C7-realtime реально сконфигурирован (Redis→WS мост поднят, W3).
   * Отдаётся в /health и /metrics, чтобы отсутствие realtime было видимым, а не
   * «тихим». Для mock-режима не задаётся.
   */
  realtimeConfigured?: boolean;
  mode?: string;
  now?: () => string;
}

export function createEdgeGatewayServer({
  core,
  tunnel = createMockEdgeTunnel({ core }),
  wsChannel = createMockWebSocketChannel(),
  edgeCluster,
  vpnTunnel,
  controlPlane,
  liveness,
  webChatBackendUrl,
  realtimeConfigured,
  mode = "m0-mock",
  now = () => new Date().toISOString(),
}: CreateEdgeGatewayServerOptions = {}) {
  const edgeTunnel = tunnel;
  const webSocketChannel = wsChannel;
  const upgradedSockets = new Set<Duplex>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://edge-gateway.local");
      const path = normalizeApiPath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "edge-gateway",
          mode,
          contracts: ["C7", "C9"],
          // Видимая деградация realtime (W3, WG-8): configured=false ⇒ события
          // менеджера/посетителю по WS не доходят (Redis→WS мост не поднят).
          realtime: {
            configured: realtimeConfigured ?? null,
            connected_clients: webSocketChannel.getMetrics?.()?.connected_clients ?? 0,
          },
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        let pending = null;
        if (edgeCluster && typeof edgeCluster.pendingCount === "function") {
          try {
            pending = await edgeCluster.pendingCount();
          } catch {
            pending = null;
          }
        }
        sendText(
          response,
          200,
          renderEdgeMetrics({
            tunnelMock: edgeTunnel.getMetrics?.(),
            ws: webSocketChannel.getMetrics?.(),
            cluster: edgeCluster?.getMetrics?.(),
            vpnTunnel: vpnTunnel?.getMetrics?.(),
            liveness,
            pending,
            realtimeConfigured,
          }),
        );
        return;
      }

      if (request.method === "GET" && path === C7_WS_PATH) {
        sendJson(response, 426, {
          title: "Upgrade Required",
          status: 426,
          contract: "C7",
          path: C7_WS_PATH,
          upgrade: "websocket",
          reconnect: C7_RECONNECT_SEMANTICS,
        });
        return;
      }

      if (request.method === "POST" && path === "/internal/edge/tunnel/messages") {
        const payload = await readJson(request);
        const ack = edgeTunnel.forward(payload);
        sendJson(response, 202, ack);
        return;
      }

      if (
        edgeCluster &&
        request.method === "POST" &&
        (path === "/internal/edge/messages" || path === "/internal/edge/ingress/messages")
      ) {
        const payload = await readJson(request);
        const result = await edgeCluster.ingest(payload);
        sendJson(response, 202, result);
        return;
      }

      // App→Edge control-канал (Этап M5): creds-sync + egress_dispatch. Активен
      // только когда рантайм собрал канальные драйверы (передан controlPlane).
      if (controlPlane && request.method === "POST" && path === "/internal/edge/control/messages") {
        const payload = await readJson(request);
        try {
          const ack = await controlPlane.handle(payload);
          sendJson(response, 202, ack);
        } catch (error) {
          sendJson(
            response,
            400,
            problem(400, "Control message rejected", (error as Error).message, []),
          );
        }
        return;
      }

      if (request.method === "POST" && path === "/mock/ws/events") {
        const payload = await readJson(request);
        sendJson(response, 202, publishC7Event(webSocketChannel, payload, now));
        return;
      }

      if (request.method === "POST" && path === "/internal/ws/events") {
        const payload = await readJson(request);
        sendJson(response, 202, publishC7Event(webSocketChannel, payload, now));
        return;
      }

      // Прозрачный edge-транзит REST Web Chat (W2, WG-3/WG-4): виджет клиента РФ
      // обращается к /api/v1/web-chat/* на Edge; Edge синхронно проксирует запрос в
      // ядро (App) поверх сетевого VPN-туннеля (AmneziaWG) и возвращает ответ.
      // Контракты C3.messages/C1 не меняются — проброс прозрачный; idempotency-key,
      // тело и статус сохраняются. Требует webChatBackendUrl (иначе — прежний 404).
      if (webChatBackendUrl && isWebChatProxyPath(path)) {
        await proxyWebChatRequest(request, response, webChatBackendUrl);
        return;
      }

      sendJson(response, 404, problem(404, "Not Found", "No Edge Gateway route matched.", []));
    } catch (error) {
      if (
        error instanceof EdgeTunnelMockValidationError ||
        error instanceof WebSocketChannelMockValidationError
      ) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match C7/C9 M0 contract.",
            error.errors,
          ),
        );
        return;
      }

      if (error instanceof PayloadError) {
        sendJson(response, error.status, problem(error.status, error.title, error.message, []));
        return;
      }

      sendJson(response, 500, problem(500, "Internal Server Error", error.message, []));
    }
  });

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", "http://edge-gateway.local");
    const path = normalizeApiPath(url.pathname);

    if (path !== C7_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.trim() === "") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Изоляция арендаторов (W3, WG-9): подписка без organization_id матчила бы все
    // события (wildcard). Требуем organization_id — иначе отклоняем апгрейд, чтобы
    // виджет/менеджер не мог подписаться на чужой поток.
    const subscription = subscriptionFromSearchParams(url.searchParams);
    if (!subscription.organizationId) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n",
      ].join("\r\n"),
    );

    upgradedSockets.add(socket);
    const connection = webSocketChannel.connect({
      afterSequenceNumber: url.searchParams.get("after_sequence_number") ?? undefined,
      lastEventId: url.searchParams.get("last_event_id") ?? undefined,
      subscription,
      send(event) {
        socket.write(encodeTextFrame(JSON.stringify(event)));
      },
    });

    let closed = false;
    let isAlive = true;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const finalize = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (keepAlive) {
        clearInterval(keepAlive);
      }
      connection.close();
      upgradedSockets.delete(socket);
    };
    const closeSocket = () => {
      finalize();
      socket.destroy();
    };

    // Keepalive (W3, WG-9): периодический ping; нет pong к следующему тику →
    // сокет считаем мёртвым и закрываем. Раньше keepalive не было вовсе.
    keepAlive = setInterval(() => {
      if (!isAlive) {
        closeSocket();
        return;
      }
      isAlive = false;
      try {
        socket.write(encodePingFrame());
      } catch {
        closeSocket();
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();

    // Декодирование входящих кадров (W3, WG-9): ранее сервер их не читал вовсе —
    // ping/pong/close/subscribe от клиента игнорировались. Обрабатываем keepalive
    // (ping→pong, pong→alive) и корректное закрытие; TEXT (subscribe виджета)
    // подтверждаем no-op — подписка берётся из query.
    const decoder = createWebSocketFrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        try {
          socket.write(encodeCloseFrame(1009, "frame too large"));
        } catch {
          // сокет уже закрыт — игнорируем
        }
        closeSocket();
        return;
      }
      for (const frame of frames) {
        if (frame.opcode === WS_OPCODE.PING) {
          try {
            socket.write(encodePongFrame(frame.payload));
          } catch {
            closeSocket();
          }
        } else if (frame.opcode === WS_OPCODE.PONG) {
          isAlive = true;
        } else if (frame.opcode === WS_OPCODE.CLOSE) {
          try {
            socket.write(encodeCloseFrame());
          } catch {
            // сокет уже закрыт — игнорируем
          }
          closeSocket();
        }
      }
    });

    socket.on("close", finalize);
    socket.on("end", () => {
      closeSocket();
    });
    socket.on("error", finalize);
  });

  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of upgradedSockets) {
      socket.destroy();
    }
    upgradedSockets.clear();
    if (typeof webSocketChannel.close === "function") {
      webSocketChannel.close();
    }
    return closeServer(callback);
  };

  return server;
}

const WEB_CHAT_PROXY_PREFIX = "/web-chat/";
// Заголовки, которые Edge переносит в ядро как есть при транзите Web Chat.
// idempotency-key — сквозной ключ реплики (ТЗ §11.12); x-bridge-edge-tunnel —
// маркер C9-туннеля виджета (ТЗ §7.6). Прочие (host/connection) не переносим.
const WEB_CHAT_PROXY_FORWARD_HEADERS = [
  "content-type",
  "accept",
  "idempotency-key",
  "x-bridge-edge-tunnel",
  "x-request-id",
];

function isWebChatProxyPath(path) {
  return path === "/web-chat" || path.startsWith(WEB_CHAT_PROXY_PREFIX);
}

/**
 * Прозрачный проброс REST Web Chat «клиент → edge → app» (W2). Читает тело,
 * переносит выбранные заголовки, форвардит исходный URL (с префиксом /api/v1) в
 * ядро и зеркалит статус/тело обратно клиенту. Идемпотентность и семантика
 * контрактов не меняются — их обеспечивает ядро (WebChatService).
 */
async function proxyWebChatRequest(request, response, backendBaseUrl) {
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  let body;
  if (hasBody) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        sendJson(response, 413, problem(413, "Payload Too Large", "Request body is too large.", []));
        return;
      }
      chunks.push(chunk);
    }
    body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  }

  const headers = {};
  for (const name of WEB_CHAT_PROXY_FORWARD_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value !== "") {
      headers[name] = value;
    }
  }

  const targetUrl = joinBackendUrl(backendBaseUrl, request.url ?? "/");
  let upstream;
  try {
    upstream = await fetch(targetUrl, { method, headers, body });
  } catch (error) {
    sendJson(
      response,
      502,
      problem(502, "Bad Gateway", `Edge could not reach App for Web Chat: ${(error as Error).message}`, []),
    );
    return;
  }

  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  response.end(payload);
}

function joinBackendUrl(baseUrl, requestUrl) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `${normalizedBase}${suffix}`;
}

function publishC7Event(webSocketChannel, payload, now) {
  const result = webSocketChannel.publish(payload);

  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    event_id: result.event.event_id,
    published_at: now(),
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new PayloadError(413, "Payload Too Large", "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PayloadError(400, "Invalid JSON", "Request body must be valid JSON.");
  }
}

function normalizeApiPath(path) {
  if (path === "/api/v1") {
    return "/";
  }

  if (path.startsWith("/api/v1/")) {
    return path.slice("/api/v1".length);
  }

  return path;
}

function subscriptionFromSearchParams(searchParams) {
  return {
    organizationId: searchParams.get("organization_id") ?? undefined,
    subscriptionId: searchParams.get("subscription_id") ?? undefined,
    conversationId: searchParams.get("conversation_id") ?? undefined,
    endpointId: searchParams.get("endpoint_id") ?? undefined,
    clientId: searchParams.get("client_id") ?? undefined,
    recipientUserId: searchParams.get("recipient_user_id") ?? undefined,
    userId: searchParams.get("user_id") ?? undefined,
    managerUserId: searchParams.get("manager_user_id") ?? undefined,
    visitorSessionId: searchParams.get("visitor_session_id") ?? undefined,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  });
  response.end(body);
}

function problem(status, title, detail, errors) {
  return {
    type: `https://bridge.local/problems/${title
      .toLowerCase()
      .replaceAll(" ", "-")}`,
    title,
    status,
    detail,
    errors,
  };
}

class PayloadError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, message: string) {
    super(message);
    this.name = "PayloadError";
    this.status = status;
    this.title = title;
  }
}
