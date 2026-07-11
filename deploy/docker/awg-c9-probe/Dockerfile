# syntax=docker/dockerfile:1
# C9-проба для PoC Этапа 0 (issue #257). Гоняет «текущий код» (vpn-transport.ts +
# vpn-tunnel.ts) через туннельные IP. Разделяет network namespace с awg-контейнером
# (network_mode: service:awg-*) в docker-compose.awg-poc.yml, поэтому обращение к
# 10.7.0.1 идёт по awg0. По образцу deploy/docker/edge-gateway/Dockerfile.
FROM node:20-alpine

WORKDIR /repo
# tsx исполняет TypeScript-исходники сервиса напрямую, без шага сборки.
RUN npm install --no-save --no-package-lock tsx@^4.23.0
COPY packages/contracts ./packages/contracts
COPY services/edge-gateway ./services/edge-gateway
COPY deploy/compose/awg-poc ./deploy/compose/awg-poc

ENV NODE_ENV=production
# Роль (c9-app | c9-probe) задаётся command в compose.
CMD ["node", "--import", "tsx", "deploy/compose/awg-poc/c9-app.ts"]
