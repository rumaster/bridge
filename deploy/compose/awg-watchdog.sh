#!/usr/bin/env bash
# Watchdog AWG-туннеля: авто-перезапуск awg-server/awg-client (стабилизация
# issue #257). Периодически проверяет, что нужные awg-контейнера подняты и
# хендшейк свежий; если нет — ПЕРЕСОЗДаёт их в актуальные network namespace
# (edge-vpn-app / edge-gateway). Пересоздание (а не просто restart) нужно, т.к.
# при пересоздании netns-провайдера зависимый awg-контейнер теряет netns и
# restart не помогает.
#
#   REPO=/root/git/bridge deploy/compose/awg-watchdog.sh loop   # цикл (для systemd)
#   deploy/compose/awg-watchdog.sh once                         # один проход
#
# Роль (AWG_WATCHDOG_ROLE):
#   both — оба кластера на одном хосте (стенд, дефолт — прежнее поведение);
#   app  — только awg-server (прод: app-хост);
#   edge — только awg-client  (прод: RF edge-хост).
# В проде кластеры на РАЗНЫХ хостах: role=app на app-хосте, role=edge на edge.
#
# Compose-инвокации переопределяемы под окружение (иные env-файлы, --no-build на
# edge, где сборка запрещена из-за памяти):
#   AWG_APP_ENV_FILES / AWG_RF_ENV_FILES  — аргументы --env-file (через пробел);
#   AWG_APP_UP_FLAGS  / AWG_RF_UP_FLAGS   — доп. флаги `compose up` (напр. --no-build).
#
# Web Chat REST-транзит forwarder (socat в netns edge-vpn-app, публикует
# backend на туннельном IP 10.7.0.1:3000): у него та же netns-хрупкость, что и у
# awg-server. При role=app/both watchdog держит его поднятым, если задан
# AWG_FWD_CONTAINER (имя контейнера) и AWG_FWD_SERVICE (compose-сервис, дефолт
# webchat-tunnel-fwd). Пусто → не следим (обратная совместимость).
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROLE="${AWG_WATCHDOG_ROLE:-both}"
INTERVAL="${AWG_WATCHDOG_INTERVAL:-30}"
MAX_HANDSHAKE_AGE="${AWG_MAX_HANDSHAKE_AGE:-180}"
APP_SERVER="${AWG_SERVER_CONTAINER:-bridge-saas-awg-server-1}"
RF_CLIENT="${AWG_CLIENT_CONTAINER:-bridge-edge-rf-awg-client-1}"
# Web Chat REST-транзит forwarder (socat, netns edge-vpn-app). Пусто → не следим
# (обратная совместимость). role=app/both: держим его поднятым как awg-server.
FWD_CONTAINER="${AWG_FWD_CONTAINER:-}"
FWD_SERVICE="${AWG_FWD_SERVICE:-webchat-tunnel-fwd}"

# Переопределяемые аргументы compose (по умолчанию — стендовые пути/поведение).
read -r -a APP_ENVFILES <<<"${AWG_APP_ENV_FILES:---env-file $REPO/.env --env-file $REPO/deploy/compose/.env.awg.app}"
read -r -a RF_ENVFILES  <<<"${AWG_RF_ENV_FILES:---env-file $REPO/.env.rf --env-file $REPO/deploy/compose/.env.awg.rf}"
read -r -a APP_UPFLAGS  <<<"${AWG_APP_UP_FLAGS:-}"
read -r -a RF_UPFLAGS   <<<"${AWG_RF_UP_FLAGS:-}"

DC_APP=(docker compose "${APP_ENVFILES[@]}"
  -f "$REPO/deploy/compose/docker-compose.yml" --profile tunnel)
DC_RF=(docker compose "${RF_ENVFILES[@]}"
  -f "$REPO/deploy/compose/docker-compose.rf.yml" --profile tunnel)

log() { echo "$(date -u +%FT%TZ) awg-watchdog: $*"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

recreate_server() { "${DC_APP[@]}" up -d --no-deps --force-recreate "${APP_UPFLAGS[@]}" awg-server >/dev/null 2>&1 || true; }
recreate_client() { "${DC_RF[@]}" up -d --no-deps --force-recreate "${RF_UPFLAGS[@]}" awg-client >/dev/null 2>&1 || true; }
recreate_fwd() { "${DC_APP[@]}" up -d --no-deps --force-recreate "${APP_UPFLAGS[@]}" "$FWD_SERVICE" >/dev/null 2>&1 || true; }

# Поднять forwarder web-chat транзита, если за ним следим и он упал (потерял netns).
ensure_fwd() {
  [ -z "$FWD_CONTAINER" ] && return 0
  if ! running "$FWD_CONTAINER"; then
    log "web-chat forwarder down → пересоздаю"; recreate_fwd
  fi
}

# true, если у указанного awg-контейнера нет свежего хендшейка с пиром.
handshake_stale() {
  local c="${1:-$RF_CLIENT}" ts now age
  ts=$(docker exec "$c" awg show awg0 latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -1)
  [ -z "${ts:-}" ] && return 0
  [ "$ts" = "0" ] && return 0
  now=$(date +%s); age=$((now - ts))
  [ "$age" -gt "$MAX_HANDSHAKE_AGE" ]
}

check_app() {
  if ! running "$APP_SERVER"; then
    log "awg-server down → пересоздаю"; recreate_server; sleep 3
  elif handshake_stale "$APP_SERVER"; then
    log "хендшейк awg-server протух → пересоздаю awg-server"; recreate_server
  fi
  ensure_fwd
}

check_edge() {
  if ! running "$RF_CLIENT"; then
    log "awg-client down → пересоздаю"; recreate_client; sleep 3; return
  fi
  if handshake_stale "$RF_CLIENT"; then
    log "хендшейк awg-client протух → пересоздаю awg-client"; recreate_client
  fi
}

check_both() {
  if ! running "$APP_SERVER"; then log "awg-server down → пересоздаю"; recreate_server; sleep 3; fi
  if ! running "$RF_CLIENT"; then log "awg-client down → пересоздаю"; recreate_client; sleep 3; fi
  # Оба живы, но хендшейк протух (NAT-idle) → пересоздать сервер и клиента-инициатора.
  if running "$APP_SERVER" && running "$RF_CLIENT" && handshake_stale "$RF_CLIENT"; then
    log "хендшейк протух → пересоздаю awg-server и awg-client"
    recreate_server; sleep 2; recreate_client
  fi
  ensure_fwd
}

check() {
  case "$ROLE" in
    app)  check_app ;;
    edge) check_edge ;;
    both) check_both ;;
    *) log "неизвестная роль '$ROLE' (both|app|edge)"; exit 2 ;;
  esac
}

case "${1:-loop}" in
  once) check ;;
  loop) log "старт (role=${ROLE}, interval=${INTERVAL}s, max_handshake_age=${MAX_HANDSHAKE_AGE}s)"
        while true; do check; sleep "$INTERVAL"; done ;;
  *) echo "usage: awg-watchdog.sh {loop|once}"; exit 2 ;;
esac
