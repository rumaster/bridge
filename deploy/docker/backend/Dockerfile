# syntax=docker/dockerfile:1
# @bridge/backend (NestJS). Контекст сборки — весь монорепозиторий: npm ci в
# npm workspaces требует package.json каждого воркспейса, а рантайм backend
# использует поднятый в корневой node_modules пакет "pg" (root devDependency,
# в services/backend/package.json он не объявлен напрямую), поэтому node_modules
# не обрезается после сборки.
FROM node:20.20.2-bookworm-slim

WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace=@bridge/backend

ENV NODE_ENV=production
WORKDIR /repo/services/backend
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/main.js"]
