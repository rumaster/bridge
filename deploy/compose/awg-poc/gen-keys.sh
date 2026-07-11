#!/usr/bin/env bash
# Генерирует одноразовую рабочую конфигурацию PoC (Q6: ключи awg genkey, PSK
# включён) в .env.awg-poc. Файл в .gitignore — ключи не попадают в git.
#
# Ключи Curve25519 и PSK создаются самим бинарником awg внутри собранного образа
# (единственный корректный источник WG-ключей). Профиль обфускации H1–H4
# генерируется случайно и записывается ОДИН раз — он общий для обеих сторон.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
ENV_FILE=".env.awg-poc"
IMAGE="bridge-awg:poc"
AWG_GO_REF="${AWG_GO_REF:-master}"
AWG_TOOLS_REF="${AWG_TOOLS_REF:-master}"

if [ -f "${ENV_FILE}" ] && [ "${1:-}" != "--force" ]; then
  echo "gen-keys: ${ENV_FILE} уже существует (--force для перегенерации)"
  exit 0
fi

echo "gen-keys: собираю образ ${IMAGE} для генерации ключей..."
docker build \
  --build-arg "AWG_GO_REF=${AWG_GO_REF}" \
  --build-arg "AWG_TOOLS_REF=${AWG_TOOLS_REF}" \
  -f "${ROOT}/deploy/docker/awg/Dockerfile" \
  -t "${IMAGE}" "${ROOT}"

awg_cmd() { docker run --rm --entrypoint awg "${IMAGE}" "$@"; }

echo "gen-keys: генерирую ключи пиров и PSK..."
CLIENT_PRIV="$(awg_cmd genkey)"
CLIENT_PUB="$(printf '%s' "${CLIENT_PRIV}" | docker run --rm -i --entrypoint awg "${IMAGE}" pubkey)"
SERVER_PRIV="$(awg_cmd genkey)"
SERVER_PUB="$(printf '%s' "${SERVER_PRIV}" | docker run --rm -i --entrypoint awg "${IMAGE}" pubkey)"
PSK="$(awg_cmd genpsk)"

# H1–H4: различные uint32 > 4 (общий профиль обфускации обеих сторон).
rand_h() { echo $(( ( (RANDOM << 15) | RANDOM ) % 2000000000 + 10 )); }
H1="$(rand_h)"; H2="$(rand_h)"; H3="$(rand_h)"; H4="$(rand_h)"
while [ "${H2}" = "${H1}" ]; do H2="$(rand_h)"; done
while [ "${H3}" = "${H1}" ] || [ "${H3}" = "${H2}" ]; do H3="$(rand_h)"; done
while [ "${H4}" = "${H1}" ] || [ "${H4}" = "${H2}" ] || [ "${H4}" = "${H3}" ]; do H4="$(rand_h)"; done

# 32-байтный сеансовый ключ прикладного слоя C9 (ещё присутствует до Этапа 2).
SESSION_KEY="$(docker run --rm --entrypoint sh "${IMAGE}" -c 'head -c32 /dev/urandom | base64 -w0')"

cat >"${ENV_FILE}" <<EOF
# Сгенерировано gen-keys.sh — одноразовая конфигурация PoC Этапа 0.
# НЕ КОММИТИТЬ (файл в .gitignore). Ключи Curve25519 + PSK (Q6).

# --- Версии исходников AmneziaWG (пин при необходимости) ---
AWG_GO_REF=${AWG_GO_REF}
AWG_TOOLS_REF=${AWG_TOOLS_REF}

# --- Ключи пиров ---
AWG_CLIENT_PRIVATE_KEY=${CLIENT_PRIV}
AWG_CLIENT_PUBLIC_KEY=${CLIENT_PUB}
AWG_SERVER_PRIVATE_KEY=${SERVER_PRIV}
AWG_SERVER_PUBLIC_KEY=${SERVER_PUB}
AWG_PRESHARED_KEY=${PSK}

# --- Профиль обфускации (H1–H4 общие для обеих сторон) ---
AWG_JC=6
AWG_JMIN=40
AWG_JMAX=70
AWG_S1=0
AWG_S2=0
AWG_H1=${H1}
AWG_H2=${H2}
AWG_H3=${H3}
AWG_H4=${H4}
AWG_MTU=1380

# --- Прикладной слой C9 (снимается на Этапе 2, Q2) ---
EDGE_VPN_SESSION_KEY=${SESSION_KEY}
EDGE_VPN_EDGE_ID=edge-rf
EDGE_VPN_EDGE_CERT=edge-rf-poc-cert
EDGE_VPN_APP_ID=app-core
EDGE_VPN_APP_CERT=app-core-poc-cert

# --- Параметры пробы ---
C9_PROBE_CONTENT_BYTES=1300000
C9_PROBE_CONNECT_TIMEOUT_MS=60000
EOF

echo "gen-keys: записан ${ENV_FILE} (ключи скрыты в git)"
