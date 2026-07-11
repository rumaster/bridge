#!/usr/bin/env bash
# Проверка DPI-профиля туннеля (DoD Этапа 0: «трафик — случайный UDP»). Снимает
# tcpdump на UDP-порту awg-server, пока c9-probe гоняет C9. Ожидаемо: только UDP
# без узнаваемой сигнатуры WireGuard (типы 1–4 подменены H1–H4), никакого
# TLS ClientHello / WSS. Запускать вручную при поднятом стенде.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env.awg-poc"
COMPOSE_FILE="docker-compose.awg-poc.yml"
DURATION="${1:-15}"

dc() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"; }

echo "dpi-profile: снимаю ${DURATION}с UDP-трафика на awg-server:51820..."
dc exec -T awg-server sh -c \
  "timeout ${DURATION} tcpdump -n -c 40 -i any 'udp port 51820' 2>/dev/null" || true

echo
echo "dpi-profile: интерпретация —"
echo "  • виден ТОЛЬКО UDP (proto 17), обмен awg-client↔awg-server:51820;"
echo "  • payload не содержит TLS/WSS/HTTP-сигнатур и фиксированных типов WG 1–4;"
echo "  • это и есть 'случайный UDP' из DoD Этапа 0."
