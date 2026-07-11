#!/usr/bin/env bash
# Энтрипойнт awg-контейнера (PoC Этапа 0, issue #257).
#
# Рендерит /etc/amnezia/amneziawg/<iface>.conf из AWG_*-переменных (Q6, вариант A —
# без общего volume; приватный ключ живёт только в env контейнера и не пишется на
# постоянный диск) и поднимает интерфейс через `awg-quick up`. Роль (client/server)
# определяется по наличию AWG_ENDPOINT (клиент-инициатор) или AWG_LISTEN_PORT
# (сервер-терминатор). H1–H4 общие для обеих сторон; Jc/Jmin/Jmax/S1/S2 значимы на
# клиенте (§2, §6 плана).
set -euo pipefail

IFACE="${AWG_INTERFACE:-awg0}"
CONF_DIR="/etc/amnezia/amneziawg"
CONF="${CONF_DIR}/${IFACE}.conf"
mkdir -p "${CONF_DIR}"

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "awg-entrypoint: переменная ${name} обязательна" >&2
    exit 1
  fi
}

require AWG_PRIVATE_KEY
require AWG_ADDRESS
require AWG_PEER_PUBLIC_KEY

emit() { printf '%s\n' "$1" >>"${CONF}"; }
emit_kv() { # emit_kv Key Value — печатает строку только если значение непустое
  local key="$1" val="${2:-}"
  if [ -n "${val}" ]; then emit "${key} = ${val}"; fi
}

: >"${CONF}"
emit "[Interface]"
emit "PrivateKey = ${AWG_PRIVATE_KEY}"
emit "Address = ${AWG_ADDRESS}"
emit_kv "ListenPort" "${AWG_LISTEN_PORT:-}"
emit_kv "MTU" "${AWG_MTU:-1380}"
# Параметры обфускации AmneziaWG. H1–H4 обязаны совпадать на обеих сторонах.
# Junk (Jc/Jmin/Jmax) значим только на клиенте-инициаторе (§2 плана). Находка
# Этапа 0: amneziawg-go отвергает Jc=0 (awg setconf → Invalid argument) и требует
# Jc>=1, если junk задан. Поэтому junk-группу эмитим ТОЛЬКО при Jc>=1, иначе
# опускаем целиком (корректная серверная конфигурация).
if [ -n "${AWG_JC:-}" ] && [ "${AWG_JC}" -ge 1 ] 2>/dev/null; then
  emit_kv "Jc"   "${AWG_JC}"
  emit_kv "Jmin" "${AWG_JMIN:-40}"
  emit_kv "Jmax" "${AWG_JMAX:-70}"
fi
emit_kv "S1"   "${AWG_S1:-}"
emit_kv "S2"   "${AWG_S2:-}"
emit_kv "H1"   "${AWG_H1:-}"
emit_kv "H2"   "${AWG_H2:-}"
emit_kv "H3"   "${AWG_H3:-}"
emit_kv "H4"   "${AWG_H4:-}"

emit ""
emit "[Peer]"
emit "PublicKey = ${AWG_PEER_PUBLIC_KEY}"
emit_kv "PresharedKey" "${AWG_PEER_PRESHARED_KEY:-}"
emit "AllowedIPs = ${AWG_PEER_ALLOWED_IPS:-10.7.0.0/24}"
emit_kv "Endpoint" "${AWG_ENDPOINT:-}"
emit_kv "PersistentKeepalive" "${AWG_PERSISTENT_KEEPALIVE:-}"

echo "awg-entrypoint: сгенерирован ${CONF} (приватный ключ и PSK скрыты):"
sed -E 's/^(PrivateKey|PresharedKey) = .*/\1 = <hidden>/' "${CONF}" >&2

# TUN-устройство обязательно (userspace-реализация).
if [ ! -c /dev/net/tun ]; then
  echo "awg-entrypoint: /dev/net/tun недоступен — нужен '--device /dev/net/tun' и CAP_NET_ADMIN" >&2
  exit 3
fi

export WG_QUICK_USERSPACE_IMPLEMENTATION="${WG_QUICK_USERSPACE_IMPLEMENTATION:-amneziawg-go}"

cleanup() {
  echo "awg-entrypoint: останавливаю ${IFACE}" >&2
  awg-quick down "${CONF}" || true
}
trap cleanup TERM INT EXIT

echo "awg-entrypoint: поднимаю интерфейс ${IFACE}"
awg-quick up "${CONF}"

# MSS clamping (Q8) — лечение PMTU black hole в маршрутизируемых топологиях.
# В PoC C9 терминируется локально на awg0, поэтому по умолчанию выключено.
if [ "${AWG_CLAMP_MSS:-0}" = "1" ]; then
  echo "awg-entrypoint: включаю MSS clamping на ${IFACE}"
  iptables -t mangle -A FORWARD -o "${IFACE}" -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --clamp-mss-to-pmtu || true
fi

awg show "${IFACE}" || true
echo "awg-entrypoint: ${IFACE} поднят, туннель активен"

# Supervisor авто-восстановления (§5.4, Этап 2): периодически проверяет, что
# интерфейс жив (иначе переподнимает), и пере-резолвит DNS публичного эндпоинта
# (awg сам резолвит host:port) — на случай смены IP App-стороны/роуминга.
supervise() {
  local interval="${AWG_SUPERVISE_INTERVAL:-15}"
  while true; do
    sleep "${interval}" || return 0
    if ! awg show "${IFACE}" >/dev/null 2>&1; then
      echo "awg-entrypoint: ${IFACE} пропал — переподнимаю" >&2
      awg-quick up "${CONF}" || true
      continue
    fi
    if [ -n "${AWG_ENDPOINT:-}" ] && [ -n "${AWG_PEER_PUBLIC_KEY:-}" ]; then
      awg set "${IFACE}" peer "${AWG_PEER_PUBLIC_KEY}" endpoint "${AWG_ENDPOINT}" 2>/dev/null || true
    fi
  done
}

# Держим namespace живым; выходим по сигналу (trap сделает awg-quick down).
supervise &
wait $!
