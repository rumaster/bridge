import { createServer } from "node:http";

import {
  MOBILE_API_BASE_PATH,
  MOBILE_API_CONTRACT_ID,
} from "../../../packages/contracts/src/mobile.mjs";
import { createDeterministicMobileApiMock } from "./deterministic-mobile-api.mjs";
import { EDGE_TUNNEL_HEADER, resolveMobileEdgeConnection } from "./edge-connection.mjs";
import { MobileDtoValidationError } from "./mobile-dto.mjs";
import { MobileSyncCursorError } from "./sync-cursor.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1024 * 1024;

export function createMobileApiServer({
  mobileApi,
  now = () => new Date().toISOString(),
  apiBaseUrl = MOBILE_API_BASE_PATH,
  realtimeUrl,
  edgeBaseUrl = process.env.EDGE_BASE_URL,
} = {}) {
  const mockMobileApi = mobileApi ?? createDeterministicMobileApiMock({ now });
  // CP-7: подключение мобильных клиентов РФ через Edge Cluster (§7.6). Резолвим один
  // раз при старте — клиент узнаёт маршрут и заголовок туннеля через /config и /health.
  const edgeConnection = resolveMobileEdgeConnection({ apiBaseUrl, realtimeUrl, edgeBaseUrl });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://mobile-api.local");
      const path = normalizeMobilePath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "mobile-api",
          mode: mockMobileApi.mode ?? "deterministic-mock",
          contract: MOBILE_API_CONTRACT_ID,
          base_path: MOBILE_API_BASE_PATH,
          edge: {
            via_edge: edgeConnection.viaEdge,
            tunnel: edgeConnection.tunnel,
          },
        });
        return;
      }

      if (request.method === "GET" && path === "/config") {
        // Обнаружение подключения мобильным клиентом РФ (CP-7): куда слать REST и
        // какой заголовок туннеля ставить, чтобы трафик шёл через Edge Cluster.
        sendJson(response, 200, {
          service: "mobile-api",
          contract: MOBILE_API_CONTRACT_ID,
          base_path: MOBILE_API_BASE_PATH,
          api_base_url: edgeConnection.apiBaseUrl,
          realtime_url: edgeConnection.realtimeUrl ?? null,
          edge: {
            via_edge: edgeConnection.viaEdge,
            tunnel: edgeConnection.tunnel,
            header: EDGE_TUNNEL_HEADER,
            headers: edgeConnection.headers,
          },
        });
        return;
      }

      if (request.method === "GET" && path === "/metrics") {
        sendText(response, 200, renderMetrics(mockMobileApi.getMetrics()));
        return;
      }

      if (request.method === "POST" && path === "/auth/login/telegram/start") {
        sendJson(response, 202, mockMobileApi.startTelegramLogin(await readJson(request)));
        return;
      }

      if (request.method === "POST" && path === "/auth/login/telegram/verify") {
        sendJson(response, 200, mockMobileApi.verifyTelegramLogin(await readJson(request)));
        return;
      }

      if (request.method === "POST" && path === "/auth/logout") {
        sendJson(response, 200, mockMobileApi.logout());
        return;
      }

      if (request.method === "GET" && path === "/auth/session") {
        sendJson(response, 200, mockMobileApi.getSession());
        return;
      }

      if (request.method === "GET" && path === "/dialogs") {
        sendJson(response, 200, mockMobileApi.listDialogs(queryToObject(url)));
        return;
      }

      const messagesMatch = path.match(/^\/dialogs\/([^/]+)\/messages$/);
      if (request.method === "GET" && messagesMatch) {
        const dialogId = decodeURIComponent(messagesMatch[1]);
        sendJson(response, 200, mockMobileApi.listMessages(dialogId, queryToObject(url)));
        return;
      }

      if (request.method === "POST" && path === "/messages") {
        sendJson(response, 202, mockMobileApi.sendMessage(await readJson(request)));
        return;
      }

      if (request.method === "GET" && path === "/notifications") {
        sendJson(response, 200, mockMobileApi.listNotifications(queryToObject(url)));
        return;
      }

      if (request.method === "GET" && path === "/sync") {
        sendJson(response, 200, mockMobileApi.sync(queryToObject(url)));
        return;
      }

      if (request.method === "POST" && path === "/devices") {
        sendJson(response, 201, mockMobileApi.registerDevice(await readJson(request)));
        return;
      }

      const deviceMatch = path.match(/^\/devices\/([^/]+)$/);
      if (request.method === "DELETE" && deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        sendJson(response, 200, mockMobileApi.revokeDevice(deviceId));
        return;
      }

      sendJson(
        response,
        404,
        problem(404, "Not Found", "No Mobile API route matched.", []),
      );
    } catch (error) {
      if (
        error instanceof MobileDtoValidationError ||
        error instanceof MobileSyncCursorError
      ) {
        sendJson(
          response,
          400,
          problem(
            400,
            "Validation failed",
            "Request payload does not match the MOBILE.v1 DTO.",
            error.errors,
          ),
        );
        return;
      }

      if (error instanceof PayloadError) {
        sendJson(response, error.status, problem(error.status, error.title, error.message, []));
        return;
      }

      sendJson(
        response,
        500,
        problem(500, "Internal Server Error", error.message, []),
      );
    }
  });
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

function normalizeMobilePath(path) {
  if (path === MOBILE_API_BASE_PATH) {
    return "/";
  }

  if (path.startsWith(`${MOBILE_API_BASE_PATH}/`)) {
    return path.slice(MOBILE_API_BASE_PATH.length);
  }

  return path;
}

function queryToObject(url) {
  return Object.fromEntries(url.searchParams.entries());
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

const METRIC_DEFINITIONS = [
  ["mobile_api_auth_proxy_total", "auth_proxy_total", "MOBILE auth proxy calls served."],
  ["mobile_api_dialogs_list_total", "dialogs_list_total", "MOBILE aggregated dialog lists served."],
  ["mobile_api_messages_list_total", "messages_list_total", "MOBILE dialog message histories served."],
  ["mobile_api_messages_send_total", "messages_send_total", "MOBILE message sends accepted."],
  ["mobile_api_messages_dedup_total", "messages_dedup_total", "MOBILE sends deduplicated by idempotency_key."],
  ["mobile_api_notifications_list_total", "notifications_list_total", "MOBILE notification feeds served."],
  ["mobile_api_sync_total", "sync_total", "MOBILE offline-sync calls served."],
  ["mobile_api_devices_registered_total", "devices_registered_total", "MOBILE devices/push tokens registered."],
  ["mobile_api_devices_revoked_total", "devices_revoked_total", "MOBILE devices revoked."],
  ["mobile_api_push_delivered_total", "push_delivered_total", "MOBILE push notifications delivered via provider."],
  ["mobile_api_push_token_deactivated_total", "push_token_deactivated_total", "MOBILE dead push tokens deactivated."],
  ["mobile_api_realtime_events_total", "realtime_events_total", "MOBILE C7 realtime events consumed."],
];

function renderMetrics(metrics) {
  const lines = [];
  for (const [name, key, help] of METRIC_DEFINITIONS) {
    lines.push(
      `# HELP ${name} ${help}`,
      `# TYPE ${name} counter`,
      `${name} ${metrics[key] ?? 0}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

class PayloadError extends Error {
  constructor(status, title, message) {
    super(message);
    this.name = "PayloadError";
    this.status = status;
    this.title = title;
  }
}
