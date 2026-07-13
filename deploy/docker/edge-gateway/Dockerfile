# syntax=docker/dockerfile:1
# @bridge/edge-gateway — сервис с минимальными runtime-зависимостями: tsx для
# запуска TypeScript-исходников и pg для production RF-буфера edge_message_buffer.
# Копируются только исходники сервиса и пакет packages/contracts, на который есть
# относительные импорты (../../../). Backend production-path проверяется отдельно
# через dist/main.js, edge-gateway не копирует legacy backend-прототипы.
# Используется отдельно в Edge-кластере РФ (docker-compose.rf.yml).
FROM node:20.20.2-alpine

WORKDIR /repo

# tsx выполняет TypeScript-исходники сервиса напрямую, без шага сборки.
# imapflow/mailparser/nodemailer — рантайм edge-owned email-драйверов (Этап M1,
# docs/plan/mail-service-selfhosted.md): edge-channel-drivers статически их
# импортирует, поэтому пакеты обязаны присутствовать в образе (Dockerfile ставит
# рантайм-зависимости явно, без npm ci по package.json).
# redis — клиент C7 Redis→WS моста (realtime, W3 docs/plan/web-chat-channel-production.md):
# redis-stream-client динамически импортирует 'redis', поэтому при заданном
# REDIS_URL пакет обязан присутствовать в образе (иначе ERR_MODULE_NOT_FOUND).
RUN npm install --no-save --no-package-lock \
  tsx@^4.19.2 \
  pg@^8.22.0 \
  imapflow@^1.4.7 \
  mailparser@^3.9.14 \
  nodemailer@^6.9.16 \
  redis@^6.1.0
COPY packages/contracts ./packages/contracts
COPY services/edge-gateway ./services/edge-gateway
WORKDIR /repo/services/edge-gateway

ENV NODE_ENV=production
# HOST по умолчанию в коде — 127.0.0.1, для доступности из других контейнеров
# сети docker-compose переопределяется на 0.0.0.0 через environment.
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--import", "tsx", "src/main.ts"]
