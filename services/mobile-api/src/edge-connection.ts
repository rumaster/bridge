/**
 * Прозрачное подключение мобильных клиентов РФ через Edge Cluster (CP-7, ТЗ §7.6, §18.7).
 *
 * Зеркало клиентского резолвера Web Chat (`apps/web-chat/src/platform/edgeConnection.ts`)
 * для SVC-MOB: если задан `edgeBaseUrl`, REST-трафик Mobile API (MOBILE.v1) идёт через
 * Edge, но контракт и семантика запросов не меняются — подключение прозрачно. Серверный
 * буфер Edge и C9-туннель держит SVC-EDGE; со стороны мобильного клиента мы лишь
 * маршрутизируем базовый URL и помечаем трафик C9-заголовком `x-bridge-edge-tunnel`,
 * чтобы Edge сопоставил туннель (владелец контракта — SVC-EDGE).
 *
 * У мобильного клиента нет WebSocket-realtime (обновления идут через `/sync` и push),
 * поэтому `realtimeUrl` — это простой passthrough, без вывода WS-адреса.
 */

export const EDGE_TUNNEL_HEADER = "x-bridge-edge-tunnel";
export const EDGE_TUNNEL_HEADER_VALUE = "mobile";

/**
 * Разрешает параметры подключения мобильного клиента с учётом маршрутизации через Edge.
 * @param {object} [input]
 * @param {string} [input.apiBaseUrl] базовый REST-URL Mobile API (без Edge)
 * @param {string} [input.realtimeUrl] адрес realtime/стрима (passthrough)
 * @param {string} [input.edgeBaseUrl] базовый URL Edge; пусто → без Edge
 * @returns {{ apiBaseUrl: string|undefined, realtimeUrl: string|undefined, viaEdge: boolean, tunnel: string|null, headers: Record<string,string> }}
 */
export function resolveMobileEdgeConnection({ apiBaseUrl, realtimeUrl, edgeBaseUrl } = {}) {
  const normalizedEdgeBaseUrl = typeof edgeBaseUrl === "string" ? edgeBaseUrl.trim() : "";

  if (!normalizedEdgeBaseUrl) {
    return {
      apiBaseUrl,
      realtimeUrl,
      viaEdge: false,
      tunnel: null,
      headers: {},
    };
  }

  // Edge проксирует те же пути MOBILE.v1 — достаточно подменить базовый URL и
  // пометить трафик заголовком туннеля, чтобы Edge сопоставил C9-туннель.
  return {
    apiBaseUrl: normalizedEdgeBaseUrl,
    realtimeUrl,
    viaEdge: true,
    tunnel: EDGE_TUNNEL_HEADER_VALUE,
    headers: {
      [EDGE_TUNNEL_HEADER]: EDGE_TUNNEL_HEADER_VALUE,
    },
  };
}
