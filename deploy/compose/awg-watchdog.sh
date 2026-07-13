#!/usr/bin/env bash
# Watchdog AWG-туннеля: авто-перезапуск awg-server/awg-client (стабилизация
# issue #257). Периодически проверяет, что оба awg-контейнера подняты и хендшейк
# свежий; если нет — ПЕРЕСОЗДаёт их в актуальные network namespace (edge-vpn-app /
# edge-gateway). Пересоздание (а не просто restart) нужно, т.к. при пересоздании
# netns-провайдера зависимый awg-контейнер теряет netns и restart не помогает.
#
#   REPO=/root/git/bridge deploy/compose/awg-watchdog.sh loop   # цикл (для systemd)
#   deploy/compose/awg-watchdog.sh once                         # один проход
#
# Требует рядом .env / .env.rf и сгенерированные deploy/compose/.env.awg.{app,rf}
# (ключи AWG). Запускается на хосте, где живут оба кластера (стенд).
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
INTERVAL="${AWG_WATCHDOG_INTERVAL:-30}"
MAX_HANDSHAKE_AGE="${AWG_MAX_HANDSHAKE_AGE:-180}"
APP_SERVER="${AWG_SERVER_CONTAINER:-bridge-saas-awg-server-1}"
RF_CLIENT="${AWG_CLIENT_CONTAINER:-bridge-edge-rf-awg-client-1}"

DC_APP=(docker compose --env-file "$REPO/.env" --env-file "$REPO/deploy/compose/.env.awg.app"
  -f "$REPO/deploy/compose/docker-compose.yml" --profile tunnel)
DC_RF=(docker compose --env-file "$REPO/.env.rf" --env-file "$REPO/deploy/compose/.env.awg.rf"
  -f "$REPO/deploy/compose/docker-compose.rf.yml" --profile tunnel)

log() { echo "$(date -u +%FT%TZ) awg-watchdog: $*"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

recreate_server() { "${DC_APP[@]}" up -d --no-deps --force-recreate awg-server >/dev/null 2>&1 || true; }
recreate_client() { "${DC_RF[@]}" up -d --no-deps --force-recreate awg-client >/dev/null 2>&1 || true; }

# true, если у клиента нет свежего хендшейка с сервером.
handshake_stale() {
  local ts now age
  ts=$(docker exec "$RF_CLIENT" awg show awg0 latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -1)
  [ -z "${ts:-}" ] && return 0
  [ "$ts" = "0" ] && return 0
  now=$(date +%s); age=$((now - ts))
  [ "$age" -gt "$MAX_HANDSHAKE_AGE" ]
}

check() {
  if ! running "$APP_SERVER"; then
    log "awg-server down → пересоздаю"; recreate_server; sleep 3
  fi
  if ! running "$RF_CLIENT"; then
    log "awg-client down → пересоздаю"; recreate_client; sleep 3
  fi
  # Оба живы, но хендшейк протух (NAT-idle) → пересоздать сервер и клиента-инициатора.
  if running "$APP_SERVER" && running "$RF_CLIENT" && handshake_stale; then
    log "хендшейк протух → пересоздаю awg-server и awg-client"
    recreate_server; sleep 2; recreate_client
  fi
}

case "${1:-loop}" in
  once) check ;;
  loop) log "старт (interval=${INTERVAL}s, max_handshake_age=${MAX_HANDSHAKE_AGE}s)"
        while true; do check; sleep "$INTERVAL"; done ;;
  *) echo "usage: awg-watchdog.sh {loop|once}"; exit 2 ;;
esac
