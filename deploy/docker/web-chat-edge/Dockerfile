# syntax=docker/dockerfile:1
# Хостируемая страница Web Chat для RF Edge (`/chat/<organizationId>`, W5).
#
# В отличие от app-стороны (node/vite-preview образ @bridge/web-chat, ~1.1 ГБ),
# на RF edge раздаём СОБРАННУЮ статику через nginx: лёгкий рантайм (важно для
# памяти edge-хоста) + прокси `/api/*` на edge-gateway, который проксирует
# `/api/v1/web-chat/*` и `/api/v1/ws` (C7 realtime) в ядро ПО AmneziaWG-туннелю.
#
# Сборка страницы (npm ci + vite build) — ТЯЖЁЛАЯ, делается в build-стадии на
# CI/сборочном хосте, НЕ на edge (там сборка запрещена по памяти — переносится
# уже готовый лёгкий образ). Контекст сборки — весь монорепозиторий (npm
# workspaces + воркспейс-пакет @bridge/api-client).
FROM node:20.20.2-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
# `npm run build` собирает и встраиваемый бандл, и хостируемую страницу (dist-page).
RUN npm run build --workspace=@bridge/web-chat

FROM nginx:alpine
# Конфиг с SPA history-fallback для /chat/<id> и прокси /api → edge-gateway
# (адрес подставляется envsubst из EDGE_GATEWAY_URL при старте контейнера).
COPY deploy/docker/web-chat-edge/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web-chat/dist-page /usr/share/nginx/html
# Адрес edge-gateway внутри RF docker-сети (перекрывается в compose при нужде).
ENV EDGE_GATEWAY_URL=http://edge-gateway:3060
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/bridge-web-chat.js >/dev/null 2>&1 || exit 1
