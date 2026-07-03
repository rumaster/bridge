# syntax=docker/dockerfile:1
# @bridge/web-chat (встраиваемый виджет, Vite lib build). Контекст сборки —
# весь монорепозиторий: npm ci в npm workspaces требует package.json каждого
# воркспейса, а сборка зависит от воркспейс-пакета @bridge/api-client.
# Сборка не содержит index.html (lib-режим Vite) — "vite preview" отдаёт
# статические JS/CSS чанки виджета для встраивания на сторонние страницы.
FROM node:20.20.2-bookworm-slim

WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace=@bridge/web-chat

ENV NODE_ENV=production
WORKDIR /repo/apps/web-chat
EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/bridge-web-chat.js').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "run", "preview"]
