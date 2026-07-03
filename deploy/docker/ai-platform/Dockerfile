# syntax=docker/dockerfile:1
# @bridge/ai-platform — сервис без внешних npm-зависимостей во время выполнения,
# поэтому образ собирается без npm ci: копируются только исходники сервиса и
# пакет packages/contracts, на который есть относительные импорты (../../../).
FROM node:20.20.2-alpine

WORKDIR /repo
COPY packages/contracts ./packages/contracts
COPY services/ai-platform ./services/ai-platform
WORKDIR /repo/services/ai-platform

ENV NODE_ENV=production
EXPOSE 3006

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3006) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/main.mjs"]
