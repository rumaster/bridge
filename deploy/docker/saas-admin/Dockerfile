# syntax=docker/dockerfile:1
# @bridge/saas-admin (Vite SPA). Контекст сборки — весь монорепозиторий: npm ci
# в npm workspaces требует package.json каждого воркспейса, а сборка зависит от
# воркспейс-пакета @bridge/api-client. Раздаётся через "vite preview", поэтому
# devDependencies (включая vite) остаются в образе.
FROM node:20.20.2-bookworm-slim

WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace=@bridge/saas-admin

ENV NODE_ENV=production
WORKDIR /repo/apps/saas-admin
EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "run", "preview"]
