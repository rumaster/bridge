/**
 * Резолвер адреса App→Edge control-plane для backend (Этап E2/MP-12).
 *
 * Раньше backend слал `C9.EdgeControlMessage` (creds-sync / egress_dispatch /
 * channel_test) прямым HTTP на `EDGE_CONTROL_URL` — адрес Edge, работавший
 * только на одно-хостовом стенде (backend и Edge в одной сети). В реальном
 * RF-разнесении backend НЕ достаёт до Edge напрямую (туннель держит процесс
 * `edge-vpn-app`), поэтому control-plane едет через туннель:
 *
 *   backend → (host-internal HTTP) → edge-vpn-app control-relay
 *           → (VPN-туннель) → Edge control-listener
 *
 * `EDGE_CONTROL_TUNNEL_URL` (адрес релея на edge-vpn-app) включает туннельный
 * путь; при его отсутствии backend остаётся на прямом HTTP (`EDGE_CONTROL_URL`)
 * как fallback для одно-хостового стенда. Тело запроса и формат ack совпадают у
 * обоих путей (релей возвращает Edge-ack либо `queued`/`error`), поэтому
 * вызывающий код меняет только адрес назначения.
 */

export interface ResolvedEdgeControlEndpoint {
  url: string;
  /** true — путь идёт через туннельный релей (edge-vpn-app), а не прямой HTTP. */
  viaTunnel: boolean;
}

export function resolveEdgeControlEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEdgeControlEndpoint | null {
  const tunnelUrl = env.EDGE_CONTROL_TUNNEL_URL?.trim();
  if (tunnelUrl) {
    return { url: tunnelUrl, viaTunnel: true };
  }
  const directUrl = env.EDGE_CONTROL_URL?.trim();
  if (directUrl) {
    return { url: directUrl, viaTunnel: false };
  }
  return null;
}

/** Плоский адрес control-plane (туннель приоритетнее), либо undefined. */
export function resolveEdgeControlUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveEdgeControlEndpoint(env)?.url;
}
