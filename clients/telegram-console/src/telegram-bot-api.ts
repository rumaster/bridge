const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export class TelegramBotApiError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly error_code: number;
  readonly parameters: Record<string, unknown>;
  readonly body: unknown;
  readonly retryAfterMs: number | null;

  constructor(message: string, { status, body, parameters = {} }: any) {
    super(message);
    this.name = "TelegramBotApiError";
    this.status = status;
    this.statusCode = status;
    this.error_code = status;
    this.parameters = parameters;
    this.body = body;
    this.retryAfterMs =
      typeof parameters.retry_after === "number" ? parameters.retry_after * 1_000 : null;
  }
}

export function createTelegramBotApiAdapter({
  token,
  apiBaseUrl = DEFAULT_TELEGRAM_API_BASE_URL,
  fetcher = getGlobalFetch(),
}: any = {}) {
  if (!isNonEmptyString(token)) {
    throw new TypeError("Telegram bot token is required");
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrl);

  return {
    sendMessage(payload: any) {
      return requestTelegram("sendMessage", payload);
    },

    answerCallbackQuery(payload: any) {
      return requestTelegram("answerCallbackQuery", payload);
    },

    getUpdates(payload: any = {}) {
      return requestTelegram("getUpdates", payload);
    },
  };

  async function requestTelegram(method: string, payload: any) {
    const response = await fetcher(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await readTelegramBody(response);

    if (!response.ok || body?.ok === false) {
      const status = Number(body?.error_code ?? response.status);
      throw new TelegramBotApiError(body?.description ?? `Telegram Bot API ${method} failed`, {
        status,
        body,
        parameters: body?.parameters ?? {},
      });
    }

    return body?.result;
  }
}

async function readTelegramBody(response: any) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (text === "") {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: response.ok, description: text };
  }
}

function normalizeBaseUrl(baseUrl: string) {
  if (!isNonEmptyString(baseUrl)) {
    throw new TypeError("apiBaseUrl must be a non-empty string");
  }
  return baseUrl.replace(/\/+$/, "");
}

function isNonEmptyString(value: any) {
  return typeof value === "string" && value.trim() !== "";
}

function getGlobalFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("fetcher option is required when global fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis);
}
