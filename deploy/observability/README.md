# Наблюдаемость AmneziaWG-туннеля (issue #257, Этап 3)

Метрики и алерты для VPN Tunnel Service. Интеграция в конкретный алертинг —
по месту развёртывания (Q10); здесь — готовые правила и пример scrape-конфига.

## Что экспонируется

| Источник | Адрес (в сети compose) | Метрики |
|---|---|---|
| `edge-gateway` `/metrics` | `edge-gateway:3000/metrics` | `edge_tunnel_liveness_up`, `edge_tunnel_*` (VPN-клиент), `edge_cluster_*` (RF-конвейер), `edge_buffer_pending` |
| awg-экспортер (Edge) | `edge-gateway:9586` | `awg_up`, `awg_peer_handshake_age_seconds`, `awg_peer_rx_bytes/tx_bytes` |
| awg-экспортер (App) | `edge-vpn-app:9586` | то же со стороны App |

awg-экспортер слушает в network namespace ноды (общий с awg-контейнером), поэтому
скрейпится по адресу **ноды**, а не отдельного awg-контейнера.

## Пример scrape-конфига Prometheus

```yaml
scrape_configs:
  - job_name: edge-gateway
    metrics_path: /metrics
    static_configs:
      - targets: ["edge-gateway:3000"]
  - job_name: awg-tunnel
    static_configs:
      - targets: ["edge-gateway:9586", "edge-vpn-app:9586"]
```

## Алерты

Правила — [`awg-tunnel.rules.yml`](./awg-tunnel.rules.yml): `AwgTunnelDown`,
`AwgTunnelHandshakeStale`, `AwgTunnelNeverHandshaked`, `EdgeChannelDegraded`,
`EdgeBufferBacklog`, `AwgExporterDown`.

Подключение:

```yaml
rule_files:
  - /etc/prometheus/rules/awg-tunnel.rules.yml
```

Диагностика срабатываний (различение **DPI-блокировка vs обычный сбой**) —
[`docs/runbooks/awg-tunnel.md`](../../docs/runbooks/awg-tunnel.md).
