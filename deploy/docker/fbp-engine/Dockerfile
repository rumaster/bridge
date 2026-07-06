# syntax=docker/dockerfile:1
# @bridge/fbp-engine. Контекст сборки — весь монорепозиторий: gRPC runtime
# берётся из npm workspace-зависимостей сервиса, а packages/contracts нужны для
# относительных импортов и proto-контракта C5.
FROM node:20.20.2-alpine

WORKDIR /repo

# tsx выполняет TypeScript-исходники сервиса напрямую, без шага сборки.
COPY . .
RUN npm ci
WORKDIR /repo/services/fbp-engine

ENV NODE_ENV=production
EXPOSE 3095
EXPOSE 3105

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3095) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--import", "tsx", "src/main.ts"]
