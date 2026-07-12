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

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface CreateEdgeGatewayServerOptions {
  core?: any;
  tunnel?: any;
  wsChannel?: any;
  edgeCluster?: any;
  vpnTunnel?: any;
  /** Control-plane App→Edge (creds-sync + egress_dispatch), Этап M5. */
  controlPlane?: { handle(message: unknown): Promise<any> };
  liveness?: { isUp(): boolean; lastProbeAt(): number | null } | null;
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
      subscription: subscriptionFromSearchParams(url.searchParams),
      send(event) {
        socket.write(encodeWebSocketTextFrame(JSON.stringify(event)));
      },
    });

    const close = () => {
      connection.close();
      upgradedSockets.delete(socket);
    };
    socket.on("close", close);
    socket.on("end", () => {
      close();
      socket.destroy();
    });
    socket.on("error", close);
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

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text, "utf8");

  if (payload.byteLength < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
  }

  if (payload.byteLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  return Buffer.concat([header, payload]);
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
