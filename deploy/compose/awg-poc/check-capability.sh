#!/usr/bin/env bash
# Проверка возможностей рантайма для userspace-туннеля (Q7 плана): наличие
# /dev/net/tun и способность получить CAP_NET_ADMIN. Используется как capability-
# gate — при отсутствии TUN интеграция помечается SKIPPED, а не падает.
#
# Коды выхода: 0 — доступно; 42 — недоступно (skip).
set -euo pipefail

ok=0

if [ -c /dev/net/tun ]; then
  echo "capability: /dev/net/tun присутствует ✓"
else
  echo "capability: /dev/net/tun ОТСУТСТВУЕТ ✗ (нужен '--device /dev/net/tun')"
  ok=1
fi

if command -v docker >/dev/null 2>&1; then
  echo "capability: docker присутствует ✓"
else
  echo "capability: docker ОТСУТСТВУЕТ ✗"
  ok=1
fi

if [ "${ok}" -eq 0 ]; then
  echo "capability: окружение поддерживает AmneziaWG userspace-туннель"
  exit 0
fi

echo "capability: окружение НЕ поддерживает туннель — интеграция будет пропущена (SKIP)"
exit 42
