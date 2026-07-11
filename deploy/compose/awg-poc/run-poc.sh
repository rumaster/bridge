#!/usr/bin/env bash
# Запуск PoC Этапа 0 (issue #257): поднимает два amneziawg-go и прогоняет C9 через
# туннельные IP. Capability-gated (Q7): при отсутствии /dev/net/tun выходит с
# кодом 0 и пометкой SKIP, чтобы не валить CI на раннерах без TUN.
#
# Exit 0 — DoD Этапа 0 закрыт (C9 прошёл внутри туннеля, кадр 2 МБ ок) или SKIP.
# Exit !=0 — реальный провал.
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE_FILE="docker-compose.awg-poc.yml"
ENV_FILE=".env.awg-poc"

if ! bash ./check-capability.sh; then
  echo "run-poc: SKIP — окружение без TUN/docker, PoC не запускается"
  exit 0
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "run-poc: ${ENV_FILE} не найден — генерирую ключи..."
  bash ./gen-keys.sh
fi

cleanup() {
  echo "run-poc: останавливаю стенд..."
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" down -v --remove-orphans || true
}
trap cleanup EXIT

echo "run-poc: собираю и поднимаю стенд..."
set +e
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up \
  --build --abort-on-container-exit --exit-code-from c9-probe
rc=$?
set -e

echo "run-poc: --- логи awg-client (профиль туннеля) ---"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" logs awg-client 2>/dev/null | tail -n 20 || true

if [ "${rc}" -eq 0 ]; then
  echo "run-poc: ✓ DoD Этапа 0 подтверждён"
else
  echo "run-poc: ✗ PoC завершился с кодом ${rc}"
fi
exit "${rc}"
