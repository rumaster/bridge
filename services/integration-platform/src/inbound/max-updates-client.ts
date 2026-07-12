/**
 * Минимальный клиент MAX Bot API `GET /updates` для входящего драйвера
 * (Этап M3, docs/plan/max-channel-production.md, вариант getUpdates long-poll).
 *
 * В отличие от Telegram (offset per-update) MAX использует **marker** — курсор
 * батча: ответ `{ updates, marker }` отдаёт новый marker для следующего запроса.
 * Токен передаётся в query `access_token` по контракту провайдера (наследие
 * TamTam). Один клиент — один токен бота; фабрика в драйвере кэширует по токену.
 */

export interface MaxUpdatesClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface GetMaxUpdatesParams {
  marker?: number | null;
  timeout?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface MaxUpdatesResult {
  updates: any[];
  marker: number | null;
}

export function createMaxUpdatesClient({
  token,
  baseUrl = "https://botapi.max.ru",
  fetchImpl = globalThis.fetch,
}: MaxUpdatesClientOptions) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new TypeError("MAX bot token is required for getUpdates");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const apiBase = baseUrl.replace(/\/+$/, "");

  return {
    async getUpdates({
      marker,
      timeout = 0,
      limit,
      signal,
    }: GetMaxUpdatesParams = {}): Promise<MaxUpdatesResult> {
      const params = new URLSearchParams();
      params.set("access_token", token);
      if (Number.isFinite(timeout)) {
        params.set("timeout", String(timeout));
      }
      if (marker !== undefined && marker !== null) {
        params.set("marker", String(marker));
      }
      if (Number.isFinite(limit)) {
        params.set("limit", String(limit));
      }

      const response = await fetchImpl(`${apiBase}/updates?${params.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });

      const parsed = await readJson(response);
      if (!response.ok) {
        const description =
          parsed?.message ?? parsed?.description ?? `MAX getUpdates failed with HTTP ${response.status}`;
        throw new Error(description);
      }

      return {
        updates: Array.isArray(parsed?.updates) ? parsed.updates : [],
        marker: parsed?.marker ?? null,
      };
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
