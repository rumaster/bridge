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

## M0/M1/M2/M3 Схема

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

Миграция `20260703093000000_m1_schema.sql` расширяет каркас до базового
вертикального среза CP-1:

- `configurations`, `configuration_history`, `audit_events`;
- `user_roles`, `auth_sessions`, `login_codes`, `invitations`;
- `clients`, `communication_endpoints`, `conversations`, `messages`,
  `attachments`, `message_delivery_attempts`.

M1 добавляет tenant RLS для всех арендо-зависимых таблиц, уникальность
`configurations(organization_id, key)` и
`communication_endpoints(organization_id, channel, external_id)`, порядок
сообщений по индексу `messages(endpoint_id, sequence_number)`, а также
append-only защиту `audit_events` и `configuration_history`.

Миграция `20260703103000000_m1_client_notes_tags.sql` добавляет клиентские
заметки и теги (`client_notes`, `client_tags`), которые входят в M2-срез
расширения профиля клиента и покрыты tenant RLS.

Миграция `20260703124000000_m2_schema.sql` добавляет схему M2:

- `knowledge_documents` со статусом индексации `indexing/indexed/failed`;
- `knowledge_chunks` с `embedding vector(1536)` и HNSW-индексом
  `knowledge_chunks_embedding_hnsw_idx`;
- `client_identity_links` с аудитом создания, обратимостью через `reverted_at`
  и единственной активной связью на endpoint;
- `channels` и `adapter_capabilities` для омниканальности и Capability Model.

Секреты каналов хранятся только ссылкой `channels.credentials_ref`; top-level
ключи `token`, `secret`, `password`, `api_key` и близкие варианты запрещены в
`channels.config`.

Миграция `20260703140000000_m3_schema.sql` добавляет схему Workflow M3 и
транзакционный outbox:

- `workflows` с закреплённой default-версией (`default_version_id`);
- `workflow_versions` — неизменяемые версии, `UNIQUE(workflow_id, version_no)`
  (ТЗ §13.10), `version_no > 0` и append-only защита;
- `workflow_instances` с version pinning через FK `version_id` (stateless
  executor запускает конкретную версию);
- `workflow_instance_state` — состояние вне исполнителя (`instance_id` PK);
- `workflow_execution_logs` — append-only журнал исполнения (ТЗ §13.9, §24.6)
  с изоляцией по арендатору;
- `outbox_events` (C-OUT, master §4.10) со статусами `pending/published/failed`,
  инвариантом согласованности `published_at`, индексами по `status` и
  частичным индексом `outbox_events_pending_idx` для выборки к доставке.

Запись `outbox_events` фиксируется в той же транзакции, что и агрегат
(атомарность outbox): событие и изменение агрегата коммитятся либо
откатываются вместе. Все шесть таблиц покрыты tenant RLS по
`organization_id`.

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
