# syntax=docker/dockerfile:1
# @bridge/edge-gateway — сервис без внешних npm-зависимостей во время
# выполнения, поэтому образ собирается без npm ci: копируются только исходники
# сервиса и пакет packages/contracts, на который есть относительные импорты
# (../../../). server.mjs также напрямую импортирует мок C2 ingress/egress из
# services/backend (../../backend/src/modules/communication-core/mock-ingress-egress.mjs),
# поэтому этот конкретный файл backend (без NestJS-обвязки) копируется тоже.
# Используется отдельно в Edge-кластере РФ (docker-compose.rf.yml).
FROM node:20.20.2-alpine

WORKDIR /repo
COPY packages/contracts ./packages/contracts
COPY services/backend/src/modules/communication-core/mock-ingress-egress.mjs ./services/backend/src/modules/communication-core/mock-ingress-egress.mjs
COPY services/edge-gateway ./services/edge-gateway
WORKDIR /repo/services/edge-gateway

ENV NODE_ENV=production
# HOST по умолчанию в коде — 127.0.0.1, для доступности из других контейнеров
# сети docker-compose переопределяется на 0.0.0.0 через environment.
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/main.mjs"]
