# syntax=docker/dockerfile:1
# @bridge/web-chat. Контекст сборки — весь монорепозиторий: npm ci в npm
# workspaces требует package.json каждого воркспейса, а сборка зависит от
# воркспейс-пакета @bridge/api-client.
# `npm run build` собирает ДВА артефакта (W5): встраиваемый ESM-бандл
# (dist/bridge-web-chat.js, lib-режим) И хостируемую SPA-страницу организации
# (dist-page/index.html, app-режим со SPA history-fallback для /chat/<id>).
# "vite preview" отдаёт dist-page: и страницу /chat/<id>, и скопированный туда
# бандл /bridge-web-chat.js для встраивания на сторонние сайты.
FROM node:20.20.2-bookworm-slim

WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace=@bridge/web-chat

ENV NODE_ENV=production
WORKDIR /repo/apps/web-chat
EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/bridge-web-chat.js').then(r => r.ok ? fetch('http://127.0.0.1:4173/') : Promise.reject()).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "run", "preview"]
