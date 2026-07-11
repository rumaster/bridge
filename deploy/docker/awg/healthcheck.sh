#!/usr/bin/env bash
# Healthcheck awg-контейнера (Q10: liveness = свежесть последнего хендшейка).
#
# server-роль (AWG_LISTEN_PORT задан): «здоров», как только интерфейс поднят и
#   слушает порт — пир может ещё не подключиться, ждать хендшейка нельзя.
# client-роль: «здоров», когда последний хендшейк с пиром свежий
#   (< AWG_HANDSHAKE_MAX_AGE, по умолчанию 3×keepalive). Это тот же сигнал, что в
#   §5.4 плана станет триггером «буферизация ↔ дренаж».
set -euo pipefail

IFACE="${AWG_INTERFACE:-awg0}"

# Интерфейс вообще существует?
awg show "${IFACE}" >/dev/null 2>&1 || exit 1

# Сервер здоров при наличии интерфейса (ждёт входящих хендшейков).
if [ -n "${AWG_LISTEN_PORT:-}" ]; then
  exit 0
fi

keepalive="${AWG_PERSISTENT_KEEPALIVE:-25}"
max_age="${AWG_HANDSHAKE_MAX_AGE:-$((keepalive * 3))}"

# latest-handshakes: строки "<pubkey>\t<unix-ts>"; 0 = хендшейка ещё не было.
now="$(date +%s)"
fresh=0
while IFS=$'\t' read -r _peer ts; do
  [ -z "${ts:-}" ] && continue
  [ "${ts}" = "0" ] && continue
  age=$((now - ts))
  if [ "${age}" -le "${max_age}" ]; then fresh=1; fi
done < <(awg show "${IFACE}" latest-handshakes 2>/dev/null)

if [ "${fresh}" = "1" ]; then exit 0; fi
exit 1
