# syntax=docker/dockerfile:1
# Инструменты работы с БД (node-pg-migrate + pg) — общие devDependencies
# корневого package.json. Образ используется двумя сервисами compose:
# "migrate" (по умолчанию, node scripts/db-migrate.mjs up) и опциональным
# "seed" (профиль seed, node scripts/db-seed.mjs), который дополнительно
# использует пакет packages/testing с детерминированными M0 seed-данными.
FROM node:20.20.2-bookworm-slim

WORKDIR /repo
COPY . .
RUN npm ci

CMD ["node", "scripts/db-migrate.mjs", "up"]
