# syntax=docker/dockerfile:1
# @bridge/telegram-console — консольный клиент без прикладных npm-зависимостей во
# время выполнения (одноразовый скрипт, не поднимает сервер). Запускается по
# требованию через профиль "tools" в docker-compose.
FROM node:20.20.2-alpine

WORKDIR /repo

# tsx выполняет TypeScript-исходники сервиса напрямую, без шага сборки.
RUN npm install --no-save --no-package-lock tsx@^4.19.2
COPY packages/contracts ./packages/contracts
COPY clients/telegram-console ./clients/telegram-console
WORKDIR /repo/clients/telegram-console

ENV NODE_ENV=production

CMD ["node", "--import", "tsx", "src/main.ts"]
