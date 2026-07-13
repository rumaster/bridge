# syntax=docker/dockerfile:1
# Провижининг-агент почтовых ящиков (scripts/mail-provision.ts serve, Этап M5
# docs/plan/mail-service-selfhosted.md). Оформлен как compose-сервис под профилем
# `mail` вместо ручного `docker run` (deploy/mail/README.md §M5).
#
# Агент управляет ящиками через `docker exec <mailserver> setup ...`, поэтому в
# образ кладётся ТОЛЬКО docker-клиент (демон не нужен — используется сокет хоста,
# монтируется в compose). Клиент берём из официального образа docker:cli — это
# статический бинарник, корректно работающий поверх debian slim.
FROM docker:27.3.1-cli AS dockercli

FROM node:20.20.2-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /repo
COPY . .
RUN npm ci

# serve поднимает HTTP-агента (POST/DELETE /provision, GET /health) на
# MAIL_PROVISION_PORT; авторизация — Bearer MAIL_PROVISION_TOKEN (см. serveAgent).
CMD ["node", "--import", "tsx", "scripts/mail-provision.ts", "serve"]
