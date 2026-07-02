# Data Platform DB

M0 использует `node-pg-migrate` как единый механизм миграций ядра.
Причины выбора:

- работает напрямую с PostgreSQL и не привязан к ORM;
- поддерживает обратимые `up`/`down` миграции и программный runner для будущего
  NestJS backend;
- позволяет хранить SQL-миграции в `db/migrations` без генерации кода.

## Команды

Все команды требуют `DATABASE_URL`.

```bash
DATABASE_URL=postgres://user:password@localhost:5432/bridge npm run db:migrate:up
DATABASE_URL=postgres://user:password@localhost:5432/bridge npm run db:seed
DATABASE_URL=postgres://user:password@localhost:5432/bridge npm run db:migrate:down
```

Интеграционная проверка поднимает PostgreSQL 16 + pgvector через Testcontainers:

```bash
npm run test:integration
```

## M0 Схема

Миграция `20260702160218000_m0_schema.sql` создаёт:

- extension `vector`;
- `organizations`;
- `roles`;
- минимальный `users`;
- функции RLS-контекста `app.current_organization_id()` и
  `app.is_platform_operator()`;
- RLS-политики для `organizations` и `users`.

Сиды `000001_m0_seed.mjs` создают детерминированные роли
`platform_operator`, `administrator`, `manager`, демо-организацию и
`seeded-admin`.

## RLS Контекст

Backend должен выставлять контекст организации на время транзакции или запроса:

```sql
SELECT set_config('app.current_organization_id', '<organization-uuid>', true);
```

Для авторизованного platform operator дополнительно выставляется:

```sql
SELECT set_config('app.is_platform_operator', 'true', true);
```

Без `app.current_organization_id` строки tenant-таблиц не видны обычной роли БД.
