# syntax=docker/dockerfile:1
# @bridge/mobile-api — сервис без внешних npm-зависимостей во время выполнения,
# поэтому образ собирается без npm ci: копируются только исходники сервиса и
# пакет packages/contracts, на который есть относительные импорты (../../../).
FROM node:20.20.2-alpine

WORKDIR /repo
COPY packages/contracts ./packages/contracts
COPY services/mobile-api ./services/mobile-api
WORKDIR /repo/services/mobile-api

ENV NODE_ENV=production
EXPOSE 3015

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3015) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/main.mjs"]
