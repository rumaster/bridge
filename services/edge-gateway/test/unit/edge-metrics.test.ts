import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderEdgeMetrics } from "../../src/edge-metrics.js";

describe("edge-metrics — Prometheus наблюдаемость туннеля (Этап 3, Q10)", () => {
  it("экспонирует liveness up/down и возраст пробы", () => {
    const nowMs = 1_000_000;
    const upText = renderEdgeMetrics({
      liveness: { isUp: () => true, lastProbeAt: () => nowMs - 3_000 },
      nowMs,
    });
    assert.match(upText, /# TYPE edge_tunnel_liveness_up gauge/);
    assert.match(upText, /edge_tunnel_liveness_up 1/);
    assert.match(upText, /edge_tunnel_liveness_last_probe_age_seconds 3/);

    const downText = renderEdgeMetrics({
      liveness: { isUp: () => false, lastProbeAt: () => null },
      nowMs,
    });
    assert.match(downText, /edge_tunnel_liveness_up 0/);
    assert.doesNotMatch(downText, /last_probe_age_seconds/);
  });

  it("экспонирует метрики VPN-клиента и EdgeCluster + pending", () => {
    const text = renderEdgeMetrics({
      vpnTunnel: {
        connect_total: 2,
        reconnect_total: 1,
        sent_total: 42,
        channel_down_total: 3,
        backpressure_total: 0,
        connected: true,
      },
      cluster: {
        ingested_total: 42,
        forwarded_total: 40,
        buffered_offline_total: 2,
        drained_total: 2,
        channel_down_total: 3,
        recovery_total: 1,
      },
      pending: 5,
    });
    assert.match(text, /edge_tunnel_sent_total 42/);
    assert.match(text, /edge_tunnel_channel_down_total 3/);
    assert.match(text, /edge_tunnel_connected 1/);
    assert.match(text, /edge_cluster_buffered_offline_total 2/);
    assert.match(text, /edge_cluster_drained_total 2/);
    assert.match(text, /edge_cluster_channel_down_total 3/);
    assert.match(text, /edge_buffer_pending 5/);
  });

  it("опускает секции при отсутствии источников (валидный вывод)", () => {
    const text = renderEdgeMetrics({});
    assert.equal(text, "\n");
    assert.doesNotMatch(text, /edge_tunnel|edge_cluster/);
  });

  it("каждая серия сопровождается HELP/TYPE и заканчивается переводом строки", () => {
    const text = renderEdgeMetrics({
      liveness: { isUp: () => true, lastProbeAt: () => null },
    });
    assert.match(text, /# HELP edge_tunnel_liveness_up .+\n# TYPE edge_tunnel_liveness_up gauge\nedge_tunnel_liveness_up 1\n/);
    assert.ok(text.endsWith("\n"));
  });
});
