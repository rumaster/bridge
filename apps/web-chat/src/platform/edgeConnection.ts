import { resolveRealtimeUrl } from "./realtimeClient";

/**
 * Прозрачное подключение клиентов РФ через Edge Cluster (CP-7, ТЗ §18.7, §7.6, §5.2).
 *
 * Виджет — потребитель соединения: если задан `edgeBaseUrl`, и REST, и WebSocket
 * идут через Edge, но контракты (C1/C7) и семантика сообщений не меняются —
 * подключение прозрачно. Серверный буфер Edge и C9-туннель держит SVC-EDGE; со
 * стороны виджета мы лишь маршрутизируем трафик и помечаем его C9-заголовком,
 * чтобы Edge мог сопоставить туннель (владелец контракта — SVC-EDGE).
 */

export const EDGE_TUNNEL_HEADER = "x-bridge-edge-tunnel";
export const EDGE_TUNNEL_HEADER_VALUE = "web_chat";

export type EdgeConnectionInput = {
  apiBaseUrl?: string;
  realtimeUrl?: string;
  edgeBaseUrl?: string;
};

export type EdgeConnection = {
  /** Базовый REST-URL с учётом маршрутизации через Edge. */
  apiBaseUrl: string | undefined;
  /** Явный WS-URL (если удалось вывести из Edge-базы). */
  realtimeUrl: string | undefined;
  /** Признак, что трафик идёт через Edge Cluster. */
  viaEdge: boolean;
  /** Заголовки C9-туннеля для REST-запросов (пусто без Edge). */
  headers: Record<string, string>;
};

export function resolveEdgeConnection({
  apiBaseUrl,
  realtimeUrl,
  edgeBaseUrl,
}: EdgeConnectionInput): EdgeConnection {
  const normalizedEdgeBaseUrl = edgeBaseUrl?.trim();

  if (!normalizedEdgeBaseUrl) {
    return {
      apiBaseUrl,
      realtimeUrl,
      viaEdge: false,
      headers: {},
    };
  }

  // Edge проксирует те же пути REST/WS — достаточно подменить базу. WS выводим из
  // Edge-базы (если явный realtimeUrl не задан), чтобы туннель тоже шёл через Edge.
  return {
    apiBaseUrl: normalizedEdgeBaseUrl,
    realtimeUrl: realtimeUrl ?? resolveRealtimeUrl(normalizedEdgeBaseUrl, undefined),
    viaEdge: true,
    headers: {
      [EDGE_TUNNEL_HEADER]: EDGE_TUNNEL_HEADER_VALUE,
    },
  };
}
