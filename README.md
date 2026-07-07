# Bridge

Минимальный каркас монорепозитория для этапа M0-00.

## Команды

- `npm run lint` - единая команда проверки всех workspace-пакетов.
- `npm test` - workspace-тесты и smoke-проверка структуры репозитория.
- `npm run build` - единая команда сборки всех workspace-пакетов.
- `npm run test:integration` - PostgreSQL 16 + pgvector через Testcontainers,
  цикл миграций SVC-DATA `up -> down -> up`.
- `npm run test:contract` - M0 contract smoke для опубликованных контрактов и
  mock-поставщиков.
- `npm run db:migrate:up` / `npm run db:migrate:down` - миграции через
  `node-pg-migrate` с `DATABASE_URL`.
- `npm run db:seed` - детерминированные M0-сиды ролей, демо-организации и
  `seeded-admin`.
- `npm run ci` - локальная последовательность `lint -> test -> build`.

Итог M0 integration gate и список входных задач M1 описаны в
[`docs/plan/m0-readiness.md`](docs/plan/m0-readiness.md).

## Docker Compose

Dockerfile каждого сервиса лежат в `deploy/docker/<service>/Dockerfile`,
docker-compose файлы — в `deploy/compose/` (соглашение мастер-плана,
[`docs/plan/README.md`](docs/plan/README.md)). Инфраструктура разделена на
два независимых кластера, которые поднимаются отдельно.

### Application Cluster (SaaS)

Backend, все деградируемые сервисы (`ai-platform`, `integration-platform`,
`broadcast-platform`, `notification-platform`, `mobile-api`, `fbp-engine`),
фронтенды (`saas-admin`, `manager-workspace`, `web-chat`) и PostgreSQL 16 +
pgvector с джобами `migrate`/`seed`:

```bash
cp .env.example .env
docker compose --env-file .env -f deploy/compose/docker-compose.yml up --build
```

Флаг `--env-file .env` обязателен: без него docker compose ищет `.env`
рядом с самим compose-файлом (`deploy/compose/`), а не в корне репозитория.

Разовый прогон детерминированных M0-сидов после того, как `migrate`
завершится успешно:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml --profile seed up seed
```

Консольный клиент `telegram-console` поднимается по требованию через профиль
`tools`. В обычном режиме это production-процесс SVC-TGC: читает обновления
Telegram Bot API через `getUpdates`, вызывает Backend REST `/api/v1` и отправляет
ответы через реальный Bot API. Для детерминированного demo без внешних вызовов
задайте `TELEGRAM_CONSOLE_MODE=mock`.

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml --profile tools run --rm telegram-console
```

Полный перечень переменных окружения и их назначение описаны в
[`.env.example`](.env.example).

### Edge Cluster (РФ)

Для серверов, физически размещённых в России (152-ФЗ), Edge-кластер
(`edge-gateway` + резидентный PostgreSQL для буфера) поднимается отдельно,
независимо от Application Cluster:

```bash
cp .env.rf.example .env.rf
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml up --build
```

VPN Tunnel Service, который в целевой архитектуре соединяет Edge Cluster с
Application Cluster, — компонент этапа M4 и пока отсутствует в коде, поэтому
в compose-файл не включён (подробности — в комментарии в начале
`docker-compose.rf.yml`). Полный перечень переменных — в
[`.env.rf.example`](.env.rf.example).
