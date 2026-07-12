import type { EdgeEmailDelivery } from "./edge-control-plane.js";

/**
 * Исходящая доставка MAX по Bot API на Edge Gateway (Этап M4 плана
 * `docs/plan/max-channel-production.md`, закрывает MG-8 по исходящему направлению).
 *
 * Реализует MAX-сеам control-plane (аналог `EdgeEmailSender`, E4): по
 * `egress_dispatch` резолвит токен организации из локального кэша control-plane
 * (передаётся в `delivery.credentials`) и вызывает `POST /messages` MAX Bot API.
 * Сетевой `fetchImpl` инъектируется — как реальный SMTP/IMAP/сокет туннеля.
 *
 * Корректность: `chat_id` = реальный чат клиента (`recipient_ref`, из
 * `endpoint.external_id`, а НЕ UUID диалога), токен — из кред организации.
 * Идемпотентность: control-plane дедуплицирует `egress_dispatch` по `control_id`;
 * сверх того `x-idempotency-key` = `message_id`.
 */

export interface EdgeMaxCredentials {
  token?: string;
  access_token?: string;
  bot_token?: string;
}

export interface CreateEdgeMaxSenderOptions {
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
}

export class EdgeMaxSenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeMaxSenderError";
  }
}

export function createEdgeMaxSender({
  baseUrl = "https://botapi.max.ru",
  fetchImpl = globalThis.fetch,
  now: _now = () => new Date().toISOString(),
}: CreateEdgeMaxSenderOptions = {}): {
  send(delivery: EdgeEmailDelivery): Promise<{ external_message_id: string }>;
  getMetrics(): Record<string, number>;
} {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const apiBase = baseUrl.replace(/\/+$/, "");
  const metrics = { sent_total: 0, failed_total: 0 };

  return {
    async send(delivery: EdgeEmailDelivery) {
      const credentials = delivery.credentials as EdgeMaxCredentials | null | undefined;
      const token = firstNonEmpty(credentials?.token, credentials?.access_token, credentials?.bot_token);
      if (!token) {
        metrics.failed_total += 1;
        throw new EdgeMaxSenderError("No MAX token available for organization");
      }

      const chatId = firstNonEmpty(delivery.recipient_ref);
      if (!chatId) {
        metrics.failed_total += 1;
        throw new EdgeMaxSenderError("Egress delivery has no recipient (recipient_ref)");
      }

      const url =
        `${apiBase}/messages?access_token=${encodeURIComponent(token)}` +
        `&chat_id=${encodeURIComponent(chatId)}`;
      const body: { text: string; attachments?: unknown[] } = { text: delivery.text ?? "" };
      if (Array.isArray(delivery.attachments) && delivery.attachments.length > 0) {
        body.attachments = delivery.attachments;
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": String(delivery.message_id ?? ""),
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        metrics.failed_total += 1;
        throw new EdgeMaxSenderError(
          `MAX Bot API request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const parsed = await readJson(response);
      if (!response.ok) {
        metrics.failed_total += 1;
        throw new EdgeMaxSenderError(
          parsed?.message ?? parsed?.description ?? `MAX Bot API rejected delivery (HTTP ${response.status})`,
        );
      }

      metrics.sent_total += 1;
      const mid = firstNonEmpty(
        parsed?.message?.body?.mid,
        parsed?.message?.mid,
        parsed?.mid,
      );

      return {
        external_message_id: mid ?? `${chatId}:${delivery.message_id ?? ""}`,
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
