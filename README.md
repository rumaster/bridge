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
