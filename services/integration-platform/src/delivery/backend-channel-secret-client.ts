import { ChannelDeliveryError } from "./errors.js";

/**
 * Клиент backend S2S-эндпоинта секрета канала (Этап T2,
 * docs/plan/telegram-channel-production.md).
 *
 * SVC-INT не имеет доступа к БД (ТЗ §22.3): токен бота организации получается по
 * `organization_id` + `channel_type` из backend `GET /internal/channels/secret`.
 * Результат кэшируется с TTL, чтобы не дёргать backend на каждое сообщение
 * (в т.ч. при массовой доставке). 404 (нет канала/секрета) кэшируется коротким
 * negative-TTL и возвращается как null; транспортные ошибки — retryable, чтобы
 * движок доставки повторил, а не зафиксировал `failed`.
 */

export interface ResolveTokenInput {
  organizationId?: string;
  channelType?: string;
}

export interface BackendChannelSecretClientOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  token: string | null;
  expiresAt: number;
}

export function createBackendChannelSecretClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  ttlMs = 60_000,
  negativeTtlMs = 15_000,
  now = () => Date.now(),
}: BackendChannelSecretClientOptions) {
  const apiBase = baseUrl.replace(/\/+$/, "");
  const cache = new Map<string, CacheEntry>();

  return {
    async resolveToken({ organizationId, channelType }: ResolveTokenInput): Promise<string | null> {
      if (!organizationId || !channelType) {
        return null;
      }

      const key = `${organizationId}:${channelType}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return cached.token;
      }

      const url =
        `${apiBase}/internal/channels/secret` +
        `?organization_id=${encodeURIComponent(organizationId)}` +
        `&channel_type=${encodeURIComponent(channelType)}`;

      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
      } catch (error) {
        throw new ChannelDeliveryError(
          `Channel secret lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true, category: "secret_lookup_unavailable" },
        );
      }

      if (response.status === 404) {
        cache.set(key, { token: null, expiresAt: now() + negativeTtlMs });
        return null;
      }

      if (!response.ok) {
        throw new ChannelDeliveryError(
          `Channel secret lookup returned HTTP ${response.status}`,
          { status: response.status, retryable: true, category: "secret_lookup_error" },
        );
      }

      const body = await readJson(response);
      const token =
        typeof body?.token === "string" && body.token.trim() !== "" ? body.token : null;
      cache.set(key, { token, expiresAt: now() + (token ? ttlMs : negativeTtlMs) });
      return token;
    },

    invalidate({ organizationId, channelType }: ResolveTokenInput): void {
      cache.delete(`${organizationId}:${channelType}`);
    },
  };
}

async function readJson(response: Response): Promise<{ token?: unknown } | null> {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
