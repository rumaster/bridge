#!/usr/bin/env bash
# Минимальный Prometheus-экспортер awg (issue #257, Этап 3). Запускается per-
# connection из socat (см. entrypoint.sh, AWG_METRICS_PORT) в namespace awg-
# контейнера: отдаёт свежесть хендшейка, rx/tx, число пиров из `awg show dump`.
# Node-контейнер awg-CLI не имеет, поэтому эти метрики отдаёт awg-контейнер;
# метрики буфера/liveness со стороны Node — на edge-gateway /metrics.
set -euo pipefail

IFACE="${AWG_INTERFACE:-awg0}"
now="$(date +%s)"
body=""
emit() { body="${body}$1
"; }

emit "# HELP awg_up AmneziaWG interface present (1) or absent (0)."
emit "# TYPE awg_up gauge"
if awg show "${IFACE}" >/dev/null 2>&1; then
  emit "awg_up 1"
else
  emit "awg_up 0"
  printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4\r\nConnection: close\r\nContent-Length: %s\r\n\r\n%s' \
    "$(printf '%s' "${body}" | wc -c)" "${body}"
  exit 0
fi

emit "# HELP awg_peer_last_handshake_seconds Unix time of last handshake (0 = never)."
emit "# TYPE awg_peer_last_handshake_seconds gauge"
emit "# HELP awg_peer_handshake_age_seconds Age of last handshake in seconds (-1 = never)."
emit "# TYPE awg_peer_handshake_age_seconds gauge"
emit "# HELP awg_peer_rx_bytes Bytes received from peer."
emit "# TYPE awg_peer_rx_bytes counter"
emit "# HELP awg_peer_tx_bytes Bytes sent to peer."
emit "# TYPE awg_peer_tx_bytes counter"

# `awg show <iface> dump`: строка 1 — интерфейс; далее пиры (tab-разделённые):
# pubkey psk endpoint allowed-ips last-handshake rx tx keepalive
while IFS=$'\t' read -r pub _psk _endpoint _allowed hs rx tx _ka; do
  [ -z "${pub:-}" ] && continue
  label="peer=\"${pub}\""
  emit "awg_peer_last_handshake_seconds{${label}} ${hs:-0}"
  if [ "${hs:-0}" -gt 0 ] 2>/dev/null; then
    emit "awg_peer_handshake_age_seconds{${label}} $((now - hs))"
  else
    emit "awg_peer_handshake_age_seconds{${label}} -1"
  fi
  emit "awg_peer_rx_bytes{${label}} ${rx:-0}"
  emit "awg_peer_tx_bytes{${label}} ${tx:-0}"
done < <(awg show "${IFACE}" dump 2>/dev/null | tail -n +2)

printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4\r\nConnection: close\r\nContent-Length: %s\r\n\r\n%s' \
  "$(printf '%s' "${body}" | wc -c)" "${body}"
