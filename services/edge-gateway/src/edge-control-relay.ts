import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { C9_CONTROL_ACK_CONTRACT, C9_VERSION } from "../../../packages/contracts/src/c9.js";
import type { DispatchResult } from "./edge-control-client.js";

/**
 * HTTP-релей App→Edge control-plane на App-стороне (Этап E2/MP-12).
 *
 * В реальном RF-разнесении backend (отдельный контейнер) НЕ имеет доступа к
 * awg-netns туннеля — им владеет процесс `edge-vpn-app`. Поэтому control-plane
 * едет симметрично входящему:
 *
 *   backend → (host-internal HTTP, этот релей) → edge-vpn-app
 *           → (VPN-туннель, edge-control-transport) → Edge control-listener
 *
 * То есть релей — App-сторонний приёмник, который принимает уже собранный
 * `C9.EdgeControlMessage` от backend и проталкивает его на Edge через туннельный
 * control-клиент (`createEdgeControlClient`), возвращая backend ack в том же
 * формате, что и прежний прямой HTTP-путь (`EDGE_CONTROL_URL`). Так backend не
 * тянет VPN-транспорт и меняет лишь адрес назначения (флаг `EDGE_CONTROL_TUNNEL_URL`).
 *
 * Семантика по типам сообщений:
 *   - `channel_test` — живая проба «здесь и сейчас»: НЕ ставится в офлайн-очередь
 *     (её отложенный дренаж бессмыслен), выполняется синхронно; при разорванном
 *     туннеле возвращается `error`+detail, а не ложный `connected`;
 *   - `channel_credentials_sync` / `egress_dispatch` — идут через `dispatch`
 *     (офлайн-очередь + идемпотентность по `control_id`): при разрыве туннеля
 *     сообщение буферизуется и не теряется, дренажится по восстановлении.
 */

export interface EdgeControlRelayDeps {
  /** createEdgeControlClient.dispatch — с офлайн-очередью и идемпотентностью. */
  dispatch(message: unknown): Promise<DispatchResult>;
  /** Синхронная отправка без очереди (для channel_test): transport.send. */
  sendNow(message: unknown): Promise<unknown>;
  /** Опциональный bearer-токен (EDGE_CONTROL_TOKEN) для парити с прямым путём. */
  authToken?: string;
  path?: string;
  now?: () => string;
  maxBodyBytes?: number;
}

const DEFAULT_PATH = "/internal/edge/control/relay";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function createEdgeControlRelayServer({
  dispatch,
  sendNow,
  authToken,
  path = DEFAULT_PATH,
  now = () => new Date().toISOString(),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}: EdgeControlRelayDeps) {
  if (typeof dispatch !== "function" || typeof sendNow !== "function") {
    throw new Error("createEdgeControlRelayServer requires dispatch() and sendNow()");
  }

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://edge-vpn-app.local");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "edge-vpn-app", role: "control-relay" });
        return;
      }

      if (request.method !== "POST" || url.pathname !== path) {
        sendJson(response, 404, { status: 404, title: "Not Found" });
        return;
      }

      if (!authorize(request, authToken)) {
        sendJson(response, 401, { status: 401, title: "Unauthorized" });
        return;
      }

      const message = await readJson(request, maxBodyBytes);
      const type = (message as { type?: unknown })?.type;
      const controlId = (message as { control_id?: unknown })?.control_id;

      // channel_test — синхронная проба, минуя очередь.
      if (type === "channel_test") {
        try {
          const ack = await sendNow(message);
          sendJson(response, 202, ack);
        } catch (error) {
          sendJson(response, 202, errorAck(controlId, describeError(error), now()));
        }
        return;
      }

      const result = await dispatch(message);
      if (!result.queued) {
        sendJson(response, 202, result.ack);
        return;
      }
      // Туннель лёг: сообщение принято в офлайн-очередь (не потеряно), backend
      // получает явный статус `queued` (для egress это трактуется как не-`sent`,
      // повтор безопасен — Edge дедупит по control_id при дренаже).
      sendJson(response, 202, queuedAck(controlId, result.reason, now()));
    } catch (error) {
      sendJson(response, 400, { status: 400, title: "Bad Request", detail: describeError(error) });
    }
  });
}

function authorize(request: IncomingMessage, expected?: string): boolean {
  if (!expected || expected.trim() === "") {
    return true;
  }
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function queuedAck(controlId: unknown, reason: string | undefined, receivedAt: string) {
  return {
    contract: C9_CONTROL_ACK_CONTRACT,
    version: C9_VERSION,
    control_id: typeof controlId === "string" ? controlId : undefined,
    accepted: true,
    duplicate: false,
    status: "queued",
    queued: true,
    ...(reason ? { detail: `edge control channel unavailable (${reason})` } : {}),
    received_at: receivedAt,
  };
}

function errorAck(controlId: unknown, detail: string, receivedAt: string) {
  return {
    contract: C9_CONTROL_ACK_CONTRACT,
    version: C9_VERSION,
    control_id: typeof controlId === "string" ? controlId : undefined,
    accepted: true,
    duplicate: false,
    status: "error",
    detail,
    received_at: receivedAt,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new Error("control relay request body is too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    throw new Error("control relay request body is empty");
  }
  return JSON.parse(raw);
}
