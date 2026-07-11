#!/usr/bin/env bash
# Генератор скоординированной пары AWG-конфигураций для Этапа 1 (issue #257):
# раскладывает ключи/PSK/профиль обфускации на две стороны туннеля —
#   deploy/compose/.env.awg.app  → App-кластер (awg-server, docker-compose.yml)
#   deploy/compose/.env.awg.rf   → Edge-кластер (awg-client, docker-compose.rf.yml)
# Общие PSK и H1–H4/S1/S2 идентичны в обоих файлах; ключи Curve25519 разные.
# Файлы .env.* в .gitignore. Подключаются к compose через доп. --env-file:
#   docker compose --env-file .env --env-file deploy/compose/.env.awg.app \
#     -f deploy/compose/docker-compose.yml --profile tunnel up -d edge-vpn-app awg-server
# (аналогично для .env.rf + .env.awg.rf на Edge-стороне).
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
IMAGE="bridge-awg:poc"
APP_ENV=".env.awg.app"
RF_ENV=".env.awg.rf"
AWG_GO_REF="${AWG_GO_REF:-master}"
AWG_TOOLS_REF="${AWG_TOOLS_REF:-master}"
AWG_ENDPOINT="${AWG_ENDPOINT:-host.docker.internal:51820}"

if { [ -f "${APP_ENV}" ] || [ -f "${RF_ENV}" ]; } && [ "${1:-}" != "--force" ]; then
  echo "awg-keygen: ${APP_ENV}/${RF_ENV} уже существуют (--force для перегенерации)"
  exit 0
fi

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "awg-keygen: собираю образ ${IMAGE}..."
  docker build \
    --build-arg "AWG_GO_REF=${AWG_GO_REF}" \
    --build-arg "AWG_TOOLS_REF=${AWG_TOOLS_REF}" \
    -f "${ROOT}/deploy/docker/awg/Dockerfile" -t "${IMAGE}" "${ROOT}"
fi

awg_cmd() { docker run --rm --entrypoint awg "${IMAGE}" "$@"; }
pub() { printf '%s' "$1" | docker run --rm -i --entrypoint awg "${IMAGE}" pubkey; }

CLIENT_PRIV="$(awg_cmd genkey)"; CLIENT_PUB="$(pub "${CLIENT_PRIV}")"
SERVER_PRIV="$(awg_cmd genkey)"; SERVER_PUB="$(pub "${SERVER_PRIV}")"
PSK="$(awg_cmd genpsk)"

rand_h() { echo $(( ( (RANDOM << 15) | RANDOM ) % 2000000000 + 10 )); }
H1="$(rand_h)"; H2="$(rand_h)"; H3="$(rand_h)"; H4="$(rand_h)"
while [ "${H2}" = "${H1}" ]; do H2="$(rand_h)"; done
while [ "${H3}" = "${H1}" ] || [ "${H3}" = "${H2}" ]; do H3="$(rand_h)"; done
while [ "${H4}" = "${H1}" ] || [ "${H4}" = "${H2}" ] || [ "${H4}" = "${H3}" ]; do H4="$(rand_h)"; done

cat >"${APP_ENV}" <<EOF
# AWG App-сторона (awg-server) — Этап 1, issue #257. НЕ КОММИТИТЬ.
AWG_GO_REF=${AWG_GO_REF}
AWG_TOOLS_REF=${AWG_TOOLS_REF}
AWG_LISTEN_PORT=51820
AWG_MTU=1380
AWG_SERVER_PRIVATE_KEY=${SERVER_PRIV}
AWG_CLIENT_PUBLIC_KEY=${CLIENT_PUB}
AWG_PRESHARED_KEY=${PSK}
AWG_S1=0
AWG_S2=0
AWG_H1=${H1}
AWG_H2=${H2}
AWG_H3=${H3}
AWG_H4=${H4}
# Единый слой (Этап 2, Q2): прикладной AES-GCM/mTLS снят, защита — на AmneziaWG.
EDGE_VPN_APP_CRYPTO=off
EOF

cat >"${RF_ENV}" <<EOF
# AWG Edge-сторона (awg-client) — Этап 1, issue #257. НЕ КОММИТИТЬ.
AWG_GO_REF=${AWG_GO_REF}
AWG_TOOLS_REF=${AWG_TOOLS_REF}
AWG_MTU=1380
AWG_CLIENT_PRIVATE_KEY=${CLIENT_PRIV}
AWG_SERVER_PUBLIC_KEY=${SERVER_PUB}
AWG_PRESHARED_KEY=${PSK}
AWG_ENDPOINT=${AWG_ENDPOINT}
AWG_PERSISTENT_KEEPALIVE=25
AWG_JC=6
AWG_JMIN=40
AWG_JMAX=70
AWG_S1=0
AWG_S2=0
AWG_H1=${H1}
AWG_H2=${H2}
AWG_H3=${H3}
AWG_H4=${H4}
# C9-адрес назначения перенастроен на туннельный IP App-стороны (Этап 1).
EDGE_VPN_APP_TCP_URL=tcp://10.7.0.1:3049
# Единый слой (Этап 2, Q2) + проактивный liveness по туннельному IP (§5.4).
EDGE_VPN_APP_CRYPTO=off
EDGE_VPN_TUNNEL_LIVENESS=on
EOF

echo "awg-keygen: записаны ${APP_ENV} и ${RF_ENV} (общие PSK/H1–H4, endpoint=${AWG_ENDPOINT})"
