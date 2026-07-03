# M0 Integration Gate и готовность к M1

Дата фиксации: 2026-07-03.

## Результат M0 gate

M0 gate закрыт автоматическими проверками репозитория:

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:contract`

`deploy/compose` пока содержит только `.gitkeep`, поэтому docker-compose skeleton
не проверяется отдельной командой. Когда compose-файлы появятся, их нужно добавить
в общий CI как отдельный integration/e2e шаг.

## Что готово

- Контракты `C1`, `C2`, `C3.auth`, `C3.base`, `C4`, `C5`, `C6`, `C7`, `C8`,
  `C9`, `C10`, `MOBILE.v1` опубликованы в `packages/contracts` и сведены в
  `M0_CONTRACT_REGISTRY`.
- Реестр проверяет обязательный набор контрактов, semver, уникальность contract
  id, путей артефактов и DTO-имен.
- Общий contract smoke стартует mock-поставщиков и проверяет `/health` плюс один
  валидный запрос по схеме для Backend CORE/IDN/API, SVC-INT, SVC-AI, SVC-FBP,
  SVC-BCAST, SVC-NOTIF, SVC-EDGE и SVC-MOB.
- Backend M0 skeleton стартует CORE/IDN/API в одном HTTP-процессе и отвечает без
  реальных SVC-AI, SVC-FBP, SVC-BCAST, SVC-NOTIF и SVC-INT. Эти зависимости
  представлены degraded mock facades в `/health`.
- Frontend skeletons `saas-admin`, `manager-workspace` и `web-chat` используют
  общий `@bridge/api-client` для JSON transport и MSW для локальных mock API без
  ручного patching.

## Readiness List для M1

- SVC-DATA: поднять M1-схему PostgreSQL, миграции и сиды для organizations,
  users, clients, conversations, messages, audit/outbox.
- SVC-IDN: заменить M0 auth mock на реальные sessions, роли и Telegram code
  verification, сохранив публичный `C3.auth`.
- SVC-CORE: реализовать persistence, idempotency, lifecycle сообщений и routing
  поверх `C1`/`C2`.
- SVC-API: закрыть M1 CRUD/read endpoints для organization/configuration,
  clients, conversations и messages по опубликованному `C3.base`.
- SVC-INT: закрепить M1 provider/consumer handoff для `C2` между canonical CORE
  message flow и adapter delivery flow, затем обновить mock smoke без изменения
  имен существующих M0 контрактов.
- Frontend: заменить демо-данные на API calls через `@bridge/api-client` в CP-1
  сценариях login, queue, dialog и message send.
- CP-1: добавить сквозной тест "manager login -> load queue -> open dialog ->
  send message -> observe CORE/INT handoff" через реальные Backend modules и
  mock внешних сервисов.
- Deploy: добавить docker-compose skeleton для Backend, PostgreSQL и mock
  external services, затем включить compose smoke в CI.
