/**
 * Минимальный клиент Telegram Bot API `getUpdates` для входящего драйвера
 * (Этап T3, docs/plan/telegram-channel-production.md, вариант P — long-poll).
 *
 * Паттерн повторяет manager-консоль
 * (`clients/telegram-console/src/telegram-bot-api.ts`), но живёт в SVC-INT и
 * работает per-channel токеном организации (токен резолвится через backend S2S,
 * см. T2). Один клиент — один токен бота; фабрика в драйвере кэширует клиентов по
 * токену.
 */

export interface TelegramUpdatesClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface GetUpdatesParams {
  offset?: number;
  timeout?: number;
  allowedUpdates?: string[];
  signal?: AbortSignal;
}

export function createTelegramUpdatesClient({
  token,
  baseUrl = "https://api.telegram.org",
  fetchImpl = globalThis.fetch,
}: TelegramUpdatesClientOptions) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new TypeError("Telegram bot token is required for getUpdates");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const apiBase = baseUrl.replace(/\/+$/, "");

  return {
    async getUpdates({ offset, timeout = 0, allowedUpdates, signal }: GetUpdatesParams = {}): Promise<any[]> {
      const body: Record<string, unknown> = { timeout };
      if (Number.isInteger(offset)) {
        body.offset = offset;
      }
      if (Array.isArray(allowedUpdates)) {
        body.allowed_updates = allowedUpdates;
      }

      const response = await fetchImpl(`${apiBase}/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      const parsed = await readJson(response);
      if (!response.ok || parsed?.ok === false) {
        const description =
          parsed?.description ?? `Telegram getUpdates failed with HTTP ${response.status}`;
        throw new Error(description);
      }

      return Array.isArray(parsed?.result) ? parsed.result : [];
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
    return { ok: response.ok, description: text };
  }
}
