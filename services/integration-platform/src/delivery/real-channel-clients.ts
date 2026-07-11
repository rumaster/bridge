import { ChannelDeliveryError } from "./errors.js";

export interface HttpChannelClientOptions {
  fetchImpl?: typeof globalThis.fetch;
  token?: string;
  url: string;
}

export interface TelegramBotApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  token: string;
}

export function createTelegramBotApiClient({
  baseUrl = "https://api.telegram.org",
  fetchImpl = globalThis.fetch,
  token,
}: TelegramBotApiClientOptions) {
  const apiBase = baseUrl.replace(/\/+$/, "");

  return {
    async deliver(delivery: any, options: any = {}) {
      const { signal } = options;
      const payload = delivery.external_payload ?? {};
      const method = payload.method ?? "sendMessage";
      const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        body: JSON.stringify(toTelegramRequestBody(method, payload)),
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": delivery.idempotency_key,
        },
        method: "POST",
        signal,
      });
      const body = await readProviderJson(response);
      if (!response.ok || body?.ok === false) {
        throw providerError("Telegram Bot API rejected delivery", response, body);
      }

      return {
        external_message_id: firstNonEmptyString(
          body?.result?.message_id,
          body?.message_id,
          `${payload.chat_id}:${delivery.idempotency_key}`,
        ),
        provider: "telegram",
        provider_response: body?.result ?? body,
      };
    },
  };
}

export interface ResolvingTelegramClientOptions {
  resolveToken: (input: { organizationId?: string; channelType?: string }) => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  channelType?: string;
}

/**
 * Telegram-клиент доставки с резолвом токена per-organization (Этап T2).
 *
 * Токен бота определяется по `organization_id` доставки через переданный
 * `resolveToken` (backend S2S), а не берётся из общего env. Реальный Bot API
 * клиент кэшируется по токену. Если токен не настроен — доставка завершается
 * НЕповторяемой ошибкой (`failed`), а не «тихим noop».
 */
export function createResolvingTelegramClient({
  resolveToken,
  baseUrl = "https://api.telegram.org",
  fetchImpl = globalThis.fetch,
  channelType = "telegram",
}: ResolvingTelegramClientOptions) {
  const clientsByToken = new Map<string, ReturnType<typeof createTelegramBotApiClient>>();

  return {
    async deliver(delivery: any, options: any = {}) {
      const organizationId = delivery?.organization_id;
      const token = await resolveToken({
        organizationId,
        channelType: delivery?.channel_type ?? channelType,
      });

      if (!token) {
        throw new ChannelDeliveryError(
          `No Telegram bot token configured for organization ${organizationId ?? "?"}`,
          { retryable: false, category: "missing_channel_secret" },
        );
      }

      let client = clientsByToken.get(token);
      if (!client) {
        client = createTelegramBotApiClient({ baseUrl, fetchImpl, token });
        clientsByToken.set(token, client);
      }

      return client.deliver(delivery, options);
    },
  };
}

export function createEmailHttpGatewayClient({
  fetchImpl = globalThis.fetch,
  token,
  url,
}: HttpChannelClientOptions) {
  return createGenericHttpChannelClient({
    fetchImpl,
    provider: "email",
    token,
    url,
  });
}

export function createMaxHttpGatewayClient({
  fetchImpl = globalThis.fetch,
  token,
  url,
}: HttpChannelClientOptions) {
  return createGenericHttpChannelClient({
    fetchImpl,
    provider: "max",
    token,
    url,
  });
}

/**
 * Реальные клиенты доставки каналов из env. Email здесь НЕ собирается: по
 * решению 1 (docs/plan/email-channel-production.md) email — Edge-owned, исходящая
 * почта отправляется по SMTP на Edge Gateway (Этап E4), а не через app-side
 * HTTP-шлюз SVC-INT. `createEmailHttpGatewayClient` сохранён как generic-клиент
 * для возможных сторонних email-over-HTTP провайдеров (§4.2), но в основной
 * email-канал не подключён.
 */
export function createRealChannelClientsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const maxUrl = env.MAX_DELIVERY_URL?.trim();

  return {
    ...(telegramToken
      ? {
          telegram: createTelegramBotApiClient({
            baseUrl: env.TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org",
            token: telegramToken,
          }),
        }
      : {}),
    ...(maxUrl
      ? {
          max: createMaxHttpGatewayClient({
            token: env.MAX_ACCESS_TOKEN?.trim() || env.MAX_BOT_TOKEN?.trim(),
            url: maxUrl,
          }),
        }
      : {}),
  };
}

function createGenericHttpChannelClient({
  fetchImpl,
  provider,
  token,
  url,
}: HttpChannelClientOptions & { provider: string }) {
  return {
    async deliver(delivery: any, options: any = {}) {
      const { signal } = options;
      const response = await fetchImpl(url, {
        body: JSON.stringify(delivery.external_payload),
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": delivery.idempotency_key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        method: "POST",
        signal,
      });
      const body = await readProviderJson(response);
      if (!response.ok) {
        throw providerError(`${provider} provider rejected delivery`, response, body);
      }

      return {
        external_message_id: firstNonEmptyString(
          body?.external_message_id,
          body?.message_id,
          body?.id,
        ),
        provider,
        provider_response: body,
      };
    },
  };
}

function toTelegramRequestBody(method, payload) {
  if (method === "sendMessage") {
    return {
      chat_id: payload.chat_id,
      text: payload.text ?? "",
    };
  }

  const mediaFieldByMethod = {
    sendDocument: "document",
    sendPhoto: "photo",
    sendVideo: "video",
    sendVoice: "voice",
  };
  const mediaField = mediaFieldByMethod[method] ?? "text";

  return {
    caption: payload.caption,
    chat_id: payload.chat_id,
    [mediaField]: payload.media,
  };
}

async function readProviderJson(response) {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function providerError(message, response, body) {
  return new ChannelDeliveryError(
    body?.description ?? body?.error ?? body?.message ?? message,
    {
      retryAfterMs: readRetryAfterMs(response),
      status: response.status,
    },
  );
}

function readRetryAfterMs(response) {
  const retryAfter = response.headers?.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
