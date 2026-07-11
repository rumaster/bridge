import { createServer } from "node:http";

/**
 * HTTP-приёмник проактивных уведомлений Telegram Console (G-8): точка входа для
 * SVC-NOTIF (telegram-плечо) — `POST /internal/notifications/telegram` с телом
 * `{ notification }`. Делегирует диспетчеру, который резолвит chat_id менеджера и
 * отправляет карточку через `router.deliverNotification`. S2S-маршрут для
 * доверенной внутренней сети (как остальные `/internal/*`).
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export interface TelegramConsoleNotificationServerOptions {
  dispatcher: { deliver: (notification: any) => Promise<any> };
  path?: string;
  logger?: any;
}

export function createTelegramConsoleNotificationServer({
  dispatcher,
  path = "/internal/notifications/telegram",
  logger = console,
}: TelegramConsoleNotificationServerOptions) {
  if (!dispatcher || typeof dispatcher.deliver !== "function") {
    throw new TypeError("dispatcher with deliver is required");
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://telegram-console.local");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "telegram-console" });
        return;
      }

      if (request.method === "POST" && url.pathname === path) {
        const body = await readJson(request);
        const notification = body?.notification ?? body;
        const result = await dispatcher.deliver(notification);
        sendJson(response, 202, result);
        return;
      }

      sendJson(response, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        sendJson(response, 400, { error: "bad_request", message });
        return;
      }
      logger?.error?.("telegram-console notification server error", { error: message });
      sendJson(response, 500, { error: "internal_error", message });
    }
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}
