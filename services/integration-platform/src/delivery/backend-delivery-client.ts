/**
 * Клиент фиксации попыток доставки в `message_delivery_attempts` через Backend
 * (ТЗ §10.8, §14.9; § 4.4 мастер-плана).
 *
 * У SVC-INT нет прямого доступа к БД (ТЗ §22.3) — попытки доставки записываются
 * исключительно через Backend API. Клиент отправляет каждую попытку (номер,
 * статус, ошибку) и одновременно служит **уведомлением ядра** о ходе доставки.
 */

export const DELIVERY_ATTEMPT_CONTRACT = "C2.DeliveryAttempt";
export const DELIVERY_ATTEMPT_VERSION = "1.0.0";
export const DELIVERY_ATTEMPT_STATUSES = Object.freeze([
  "pending",
  "sent",
  "delivered",
  "failed",
]);

const DEFAULT_PATH = "/internal/delivery/attempts";

/** Опции {@link createBackendDeliveryClient}. */
export interface BackendDeliveryClientOptions {
  baseUrl?: string;
  path?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => string;
}

/** Вход `recordAttempt`: строка журнала попытки доставки (колонки `message_delivery_attempts`). */
export interface RecordDeliveryAttemptInput {
  organizationId: string;
  messageId: string;
  adapter: string;
  attemptNo: number;
  status: string;
  error?: unknown;
  occurredAt?: string;
}

export function createBackendDeliveryClient({
  baseUrl,
  path = DEFAULT_PATH,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
}: BackendDeliveryClientOptions = {}) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("baseUrl is required to record delivery attempts");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const endpoint = new URL(path, ensureTrailingSlash(baseUrl)).toString();

  return {
    endpoint,

    async recordAttempt({
      organizationId,
      messageId,
      adapter,
      attemptNo,
      status,
      error = null,
      occurredAt,
    }: RecordDeliveryAttemptInput) {
      assertNonEmptyString(organizationId, "organizationId");
      assertNonEmptyString(messageId, "messageId");
      assertNonEmptyString(adapter, "adapter");
      if (!Number.isInteger(attemptNo) || attemptNo < 1) {
        throw new TypeError("attemptNo must be a positive integer");
      }
      if (!DELIVERY_ATTEMPT_STATUSES.includes(status)) {
        throw new TypeError(
          `status must be one of: ${DELIVERY_ATTEMPT_STATUSES.join(", ")}`,
        );
      }

      const body = {
        contract: DELIVERY_ATTEMPT_CONTRACT,
        version: DELIVERY_ATTEMPT_VERSION,
        organization_id: organizationId,
        message_id: messageId,
        adapter,
        attempt_no: attemptNo,
        status,
        error: error ?? null,
        occurred_at: occurredAt ?? now(),
      };

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await safeReadText(response);
        const failure: Error & { status?: number } = new Error(
          `Backend rejected delivery attempt with HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`,
        );
        failure.status = response.status;
        throw failure;
      }

      return { recorded: true, attempt: body, status: response.status };
    },
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

async function safeReadText(response) {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}
