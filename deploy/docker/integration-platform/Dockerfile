# syntax=docker/dockerfile:1
# @bridge/integration-platform — сервис без прикладных npm-зависимостей во время
# выполнения, поэтому образ собирается без npm ci: копируются только исходники
# сервиса и пакет packages/contracts, на который есть относительные импорты
# (../../../).
FROM node:20.20.2-alpine

WORKDIR /repo

# tsx выполняет TypeScript-исходники сервиса напрямую, без шага сборки.
RUN npm install --no-save --no-package-lock tsx@^4.19.2
COPY packages/contracts ./packages/contracts
COPY services/integration-platform ./services/integration-platform
WORKDIR /repo/services/integration-platform

ENV NODE_ENV=production
EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--import", "tsx", "src/main.ts"]
