/**
 * Prometheus-метрики Edge Gateway (issue #257, Этап 3, Q10).
 *
 * Экспонирует наблюдаемость VPN-туннеля и RF-first-конвейера на стороне Node:
 *   - liveness туннеля (up/down, возраст последней пробы) — сигнал §5.4;
 *   - метрики VPN edge-клиента (connect/reconnect/sent/channel_down/backpressure);
 *   - метрики EdgeCluster (ingest/forward/буферизация/дренаж/recovery) + текущий
 *     размер RF-буфера (pending).
 *
 * rx/tx и точная «свежесть хендшейка» самого awg0 отдаются отдельным
 * awg-экспортером в namespace awg-контейнера (deploy/docker/awg/awg-metrics.sh),
 * т.к. awg-CLI в Node-контейнере нет. Интеграция в конкретный алертинг — по месту
 * (Q10); правила — deploy/observability/awg-tunnel.rules.yml.
 */

export interface EdgeMetricsSources {
  /** Метрики mock-туннеля (createMockEdgeTunnel.getMetrics()). */
  tunnelMock?: Record<string, number> | null;
  /** Метрики mock C7 WS-канала. */
  ws?: Record<string, number> | null;
  /** Метрики EdgeCluster.getMetrics(). */
  cluster?: Record<string, number> | null;
  /** Метрики VPN edge-клиента (createVpnTunnelEdgeClient.getMetrics()). */
  vpnTunnel?: Record<string, unknown> | null;
  /** Liveness-link туннеля (§5.4). */
  liveness?: { isUp(): boolean; lastProbeAt(): number | null } | null;
  /** Текущий размер RF-буфера (pending), best-effort. */
  pending?: number | null;
  /** C7-realtime сконфигурирован (Redis→WS мост поднят, W3). undefined → не рендерим. */
  realtimeConfigured?: boolean;
  nowMs?: number;
}

interface Series {
  name: string;
  type: "counter" | "gauge";
  help: string;
  value: number;
  labels?: Record<string, string>;
}

function renderSeries(series: Series[]): string {
  const lines: string[] = [];
  for (const s of series) {
    if (!Number.isFinite(s.value)) {
      continue;
    }
    lines.push(`# HELP ${s.name} ${s.help}`);
    lines.push(`# TYPE ${s.name} ${s.type}`);
    const labels = s.labels
      ? `{${Object.entries(s.labels)
          .map(([k, v]) => `${k}="${String(v).replaceAll('"', '\\"')}"`)
          .join(",")}}`
      : "";
    lines.push(`${s.name}${labels} ${s.value}`);
  }
  return `${lines.join("\n")}\n`;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Рендерит Prometheus text-exposition для Edge Gateway. */
export function renderEdgeMetrics({
  tunnelMock,
  ws,
  cluster,
  vpnTunnel,
  liveness,
  pending,
  realtimeConfigured,
  nowMs = Date.now(),
}: EdgeMetricsSources = {}): string {
  const series: Series[] = [];

  // Видимая деградация C7-realtime (W3, WG-8): 0 ⇒ Redis→WS мост не поднят,
  // события менеджера/посетителю по WS не доходят.
  if (realtimeConfigured !== undefined) {
    series.push({
      name: "edge_c7_realtime_configured",
      type: "gauge",
      help: "C7 realtime Redis→WS bridge configured on the Edge (1/0).",
      value: realtimeConfigured ? 1 : 0,
    });
  }

  if (tunnelMock) {
    series.push(
      { name: "edge_gateway_mock_tunnel_forwarded_total", type: "counter", help: "C9 tunnel messages forwarded by the Edge mock.", value: num(tunnelMock.forwarded_total) },
      { name: "edge_gateway_mock_tunnel_duplicate_total", type: "counter", help: "C9 duplicate idempotency keys skipped by the Edge mock.", value: num(tunnelMock.duplicate_total) },
      { name: "edge_gateway_mock_tunnel_rejected_total", type: "counter", help: "Invalid C9 tunnel messages rejected by the Edge mock.", value: num(tunnelMock.rejected_total) },
    );
  }
  if (ws) {
    series.push(
      { name: "edge_gateway_mock_ws_connection_total", type: "counter", help: "C7 mock WebSocket connections accepted.", value: num(ws.connection_total) },
      { name: "edge_gateway_mock_ws_event_published_total", type: "counter", help: "C7 mock events published.", value: num(ws.event_published_total) },
    );
  }

  // --- VPN-туннель: liveness (§5.4) ---
  if (liveness) {
    series.push({
      name: "edge_tunnel_liveness_up",
      type: "gauge",
      help: "AmneziaWG tunnel liveness from active probe (1 = up, 0 = down).",
      value: liveness.isUp() ? 1 : 0,
    });
    const lastProbeAt = liveness.lastProbeAt();
    if (lastProbeAt != null) {
      series.push({
        name: "edge_tunnel_liveness_last_probe_age_seconds",
        type: "gauge",
        help: "Seconds since the last tunnel liveness probe.",
        value: Math.max(0, (nowMs - lastProbeAt) / 1000),
      });
    }
  }

  // --- VPN edge-клиент ---
  if (vpnTunnel) {
    series.push(
      { name: "edge_tunnel_connect_total", type: "counter", help: "VPN edge client successful connects.", value: num(vpnTunnel.connect_total) },
      { name: "edge_tunnel_reconnect_total", type: "counter", help: "VPN edge client auto-reconnects.", value: num(vpnTunnel.reconnect_total) },
      { name: "edge_tunnel_sent_total", type: "counter", help: "C9 messages sent through the VPN tunnel.", value: num(vpnTunnel.sent_total) },
      { name: "edge_tunnel_channel_down_total", type: "counter", help: "VPN edge client channel-down events.", value: num(vpnTunnel.channel_down_total) },
      { name: "edge_tunnel_backpressure_total", type: "counter", help: "VPN edge client backpressure signals.", value: num(vpnTunnel.backpressure_total) },
      { name: "edge_tunnel_connected", type: "gauge", help: "VPN edge client currently connected (1/0).", value: vpnTunnel.connected ? 1 : 0 },
    );
  }

  // --- EdgeCluster: RF-first-конвейер (§7.9) ---
  if (cluster) {
    const map: Array<[string, string, "counter" | "gauge"]> = [
      ["ingested_total", "RF Edge messages accepted by EdgeCluster.", "counter"],
      ["fixed_in_rf_total", "RF-first buffer writes completed before forwarding.", "counter"],
      ["forwarded_total", "RF Edge messages forwarded through the tunnel.", "counter"],
      ["buffered_offline_total", "Messages buffered because the tunnel was down.", "counter"],
      ["drained_total", "Buffered messages drained after tunnel recovery.", "counter"],
      ["channel_down_total", "Tunnel channel-down events observed by EdgeCluster.", "counter"],
      ["backpressure_total", "App backpressure signals observed by EdgeCluster.", "counter"],
      ["buffer_backpressure_total", "RF buffer backpressure (capacity) events.", "counter"],
      ["recovery_total", "Drain/recovery cycles executed.", "counter"],
      ["duplicate_total", "Duplicate idempotency keys deduplicated at Edge.", "counter"],
      ["expired_skipped_total", "Buffered messages skipped due to TTL expiry.", "counter"],
    ];
    for (const [key, help, type] of map) {
      series.push({ name: `edge_cluster_${key}`, type, help, value: num(cluster[key]) });
    }
  }
  if (pending != null && Number.isFinite(pending)) {
    series.push({
      name: "edge_buffer_pending",
      type: "gauge",
      help: "Current pending (not yet forwarded) messages in the RF buffer.",
      value: pending,
    });
  }

  return renderSeries(series);
}
