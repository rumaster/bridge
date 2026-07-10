/**
 * Клиент backend S2S-эндпоинта списка каналов (Этап T3,
 * docs/plan/telegram-channel-production.md).
 *
 * SVC-INT не имеет доступа к БД (ТЗ §22.3): чтобы поднять входящий поллер на
 * каждый подключённый telegram-бот и смаппить апдейт бота → организацию, драйвер
 * периодически берёт реестр активных каналов у backend
 * `GET /internal/channels?channel_type=telegram`. Ответ — маршрутный минимум
 * `{channel_id, organization_id, config}` БЕЗ токена; сам токен резолвится
 * отдельным secret-клиентом (T2, backend-channel-secret-client.ts).
 */

export interface BackendChannelsClientOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface ActiveChannel {
  channelId: string;
  organizationId: string;
  config: Record<string, unknown>;
}

export interface ListChannelsInput {
  channelType: string;
}

export function createBackendChannelsClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
}: BackendChannelsClientOptions) {
  const apiBase = baseUrl.replace(/\/+$/, "");

  return {
    async listChannels({ channelType }: ListChannelsInput): Promise<ActiveChannel[]> {
      const url = `${apiBase}/internal/channels?channel_type=${encodeURIComponent(channelType)}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Backend channel list returned HTTP ${response.status}`);
      }

      const body = await readJson(response);
      const rows = Array.isArray(body)
        ? body
        : Array.isArray(body?.channels)
          ? body.channels
          : [];

      return rows
        .map((row: any) => ({
          channelId: firstString(row?.channel_id, row?.channelId, row?.id),
          organizationId: firstString(row?.organization_id, row?.organizationId),
          config: isRecord(row?.config) ? row.config : {},
        }))
        .filter((channel): channel is ActiveChannel =>
          Boolean(channel.channelId && channel.organizationId),
        );
    },
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (text.trim() === "") {
    return [];
  }
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
