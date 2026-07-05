# syntax=docker/dockerfile:1
# @bridge/edge-gateway — сервис без прикладных npm-зависимостей во время
# выполнения, поэтому образ собирается без npm ci: копируются только исходники
# сервиса и пакет packages/contracts, на который есть относительные импорты
# (../../../). Backend production-path проверяется отдельно через dist/main.js,
# edge-gateway mock не копирует и не исполняет legacy backend-прототипы.
# Используется отдельно в Edge-кластере РФ (docker-compose.rf.yml).
FROM node:20.20.2-alpine

WORKDIR /repo

# tsx выполняет TypeScript-исходники сервиса напрямую, без шага сборки.
RUN npm install --no-save --no-package-lock tsx@^4.19.2
COPY packages/contracts ./packages/contracts
COPY services/edge-gateway ./services/edge-gateway
WORKDIR /repo/services/edge-gateway

ENV NODE_ENV=production
# HOST по умолчанию в коде — 127.0.0.1, для доступности из других контейнеров
# сети docker-compose переопределяется на 0.0.0.0 через environment.
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--import", "tsx", "src/main.ts"]
