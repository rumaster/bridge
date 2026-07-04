# Аудит `.mjs`-логики backend относительно продакшн-сборки (issue #189)

**Дата:** 2026-07-04
**Область:** `services/backend/src` — сопоставление `.mjs`-прототипов с исполняемым
NestJS/TypeScript-кодом, компилируемым в `dist/main.js`.

## Ключевой факт об изоляции `.mjs`

Production backend собирается только из `.ts`: `npm run build --workspace=@bridge/backend`
= `tsc -p tsconfig.build.json` → `dist/main.js`, и Docker-образ запускает именно
`node dist/main.js` (`deploy/docker/backend/Dockerfile:21`). Точка входа — `src/main.ts`
→ `src/bootstrap.ts` → `AppModule`.

Ни один исполняемый `.ts`/production-файл **не импортирует** `.mjs`: единственные
упоминания `.mjs` в `.ts` — это doc-комментарии. Все `.mjs` импортируют только друг
друга и `packages/contracts/*.mjs`. То есть весь набор `.mjs` в `services/backend/src`
— изолированный прототип, **в `dist/main.js` не попадает**. В сборке/линте `.mjs`
только синтаксически проверялись `node --check`, а исполнялись лишь `node --test`
(`.mjs`-тесты). Логика, жившая **только** в `.mjs`, в production не работала.

Это и было причиной 404 на `POST /internal/ingress/messages`: messaging-путь
существовал только в `communication-core-m1.mjs`, не попадая в prod.

---

## Статус по 13 пунктам issue #189

### Пункт 1 — `POST /internal/ingress/messages` как NestJS-контроллер

**ПОДТВЕРЖДЕНО (реализовано в этой ветке).**
- Контроллер: `src/modules/communication-core/internal-messaging.controller.ts:31`
  (`@Controller("internal")` + `@Post("ingress/messages")`, `@Version(VERSION_NEUTRAL)`,
  `@HttpCode(202)`).
- Подключён в `communication-core-proxy.module.ts` (controllers), который входит в
  `AppModule`.
- Путь без префикса `api`/версии обеспечен исключением в
  `bootstrap.ts:37` (`setGlobalPrefix("api", { exclude: [...] })`), что совпадает с
  `CORE_INGRESS_URL=http://backend:3000/internal/ingress/messages` из docker-compose.
- Сервис `internal-messaging.service.ts` (`acceptIngress`) сохраняет сообщение в
  Postgres через `PgDatabase.withTenant` (RLS), идемпотентно по `message_id`.
- Сквозной тест end-to-end на реальном Postgres:
  `test/integration/internal-messaging.spec.ts` («принимает входящее сообщение и
  идемпотентно защищает от дублей»).

### Пункт 2 — `POST /internal/egress/messages` как NestJS-контроллер

**ПОДТВЕРЖДЕНО (реализовано в этой ветке).**
- `internal-messaging.controller.ts:38` (`@Post("egress/messages")`).
- `internal-messaging.service.ts` (`handoffEgress`): переход `routed→sent`, запись
  попытки в `message_delivery_attempts`, построение конверта `C2.EgressDelivery`
  (`buildC2EgressDelivery`) и пересылка в integration-platform через
  `forwardEgressDelivery` (`INTEGRATION_EGRESS_URL`, POST
  `/internal/egress/deliveries` — приёмник в `services/integration-platform/src/server.mjs:98`).
- Тест: `test/integration/internal-messaging.spec.ts` («передаёт исходящее сообщение
  (routed→sent) и фиксирует попытку доставки»).

### Пункт 3 — логика `communication-core-m1.mjs` портирована в исполняемый TS

**ПОДТВЕРЖДЕНО.**
- Машина состояний C1 → `message-status.ts` (`assertMessageStatusTransition`,
  `MESSAGE_STATUS_TRANSITIONS`), unit-тесты `test/unit/message-status.spec.ts`.
- Нормализация C2-конвертов, `uuidFromText`, `buildC2EgressDelivery` →
  `internal-messaging.dto.ts`, unit-тесты `test/unit/internal-messaging.dto.spec.ts`.
- Postgres-хранилище ingress/egress/delivery → `internal-messaging.service.ts`.
- Чтение диалогов/сообщений и `POST /messages` (ответ оператора) уже были в
  `communication-core-proxy.service.ts` + `communication-core.controller.ts`.
- **Оговорка:** вспомогательные адаптеры прототипа `InMemoryC7EventPublisher`
  (C7 WebSocket-события) и `FbpWorkflowOutboxPublisher` как отдельные абстракции в
  `.ts` пофайлово не воспроизведены — это внутренние прототипные адаптеры; эндпоинт-
  логика ядра покрыта. Публикация C7-событий по WS — отдельная функциональность
  (SVC-EDGE), не входит в messaging-путь ingress/egress.

### Пункт 4 — `communication-core-m4.mjs` (Edge Intake / Broadcast Delivery)

**ПОРТИРОВАНО в production TypeScript (issue #191).**
- C9 Edge Intake: `communication-core-m4.dto.ts` + `edge-intake.service.ts` +
  `POST /internal/edge/tunnel/messages` в `internal-messaging.controller.ts`.
  Путь валидирует C9/C1, восстанавливает порядок в batch-координаторе,
  дедуплицирует по `idempotency_key` и передаёт payload в единый ingress-путь.
- C8 Broadcast Delivery: `communication-core-m4.dto.ts` +
  `internal-messaging.service.ts#deliverBroadcast` +
  `POST /internal/broadcast/deliveries`. Путь создаёт outbound
  broadcast-сообщение, фиксирует `broadcast_messages ↔ messages`, доставляет через
  C2 egress и пишет `message_delivery_attempts`.
- `communication-core-m4.mjs` удалён. Старые `.mjs` contract/e2e тесты получают
  compatibility exports из `communication-core/index.mjs`; production-сборка
  использует NestJS `.ts`.

### Пункт 5 — `communication-core-m5.mjs` (Adapter Failure / AI Degradation / Load Probe)

**ПОРТИРОВАНО и подключено к реальному пути (issue #191).**
- Adapter Failure: `communication-core-m5.service.ts#AdapterFailureCoordinator`
  используется в `internal-messaging.service.ts` для egress и broadcast-delivery:
  bounded timeout/retry, промежуточные failed attempts без terminal transition,
  финальный `sent`/`failed`.
- AI Degradation: `ai-degradation.guard.ts` зарегистрирован в
  `AiIntegrationModule` и используется `AiIntegrationFacade` для C4 fallback.
- Load Probe: `CommunicationCoreLoadProbeService` подключён к ingress-path и
  экспортирует counters/latency через `MetricsService` (`/metrics`).
- `communication-core-m5.mjs` удалён. Compatibility exports для старых `.mjs`
  тестов оставлены в `communication-core/index.mjs`; production-сборка использует
  `.ts`.

### Пункт 6 — `POST /auth/login/telegram/start` и `/verify` — NestJS, не `.mjs`

**ПОДТВЕРЖДЕНО.**
- `src/modules/identity/telegram-auth.controller.ts:39` (`@Post("login/telegram/start")`,
  `@Version("1")`, 202) и `:54` (`@Post("login/telegram/verify")`, `@Version("1")`, 200).
- Бизнес-логика: `telegram-auth.service.ts` (`startLogin`, `verifyLogin`) — Postgres,
  HMAC-хэш кода, lockout, consume, создание сессии.
- Итоговые prod-маршруты: `POST /api/v1/auth/login/telegram/start` и `/verify`
  (глобальный префикс `api` + версия `1`). Контроллер `identity-controller.mjs` в prod
  не участвует.
- **Оговорка (гэп):** в `telegram-auth.service.ts` **нет rate-limiting (429)** на
  start/verify, который присутствовал в `identity-service.mjs`
  (`startRateLimiter`/`verifyRateLimiter`). Это единственная непортированная защита
  этого пути — если требуется, донести отдельно.

### Пункт 7 — `GET /auth/session` — NestJS, формат для фронтендов

**ПОДТВЕРЖДЕНО.**
- `telegram-auth.controller.ts:31` (`@Get("session")` под `SessionAuthGuard`,
  `@Version("1")` → `GET /api/v1/auth/session`).
- Формат ответа (`AuthSessionContext`, собирается в `session-auth.guard.ts` `toAuthContext`):
  `{ authenticated, expiresAt, implementationStage:"M2", organization{id,name,slug,status},
  roleBindings[], roles[], session{id,mode:"server",issuedAt,expiresAt,revokedAt}, token,
  user{id,displayName,role,status,telegramUsername,organizationId} }` — потребляется
  saas-admin и manager-workspace.

### Пункт 8 — доставка Telegram-кода: реальный Bot API или задокументированный мок

**ПОДТВЕРЖДЕНО (реальный Bot API с осознанной деградацией).**
- `src/modules/identity/telegram-bot.service.ts:78` — при заданном `TELEGRAM_BOT_TOKEN`
  сервис вызывает Telegram Bot API `sendMessage` (`sendMessage` :206; резолвинг
  `@username → chat_id` через `getUpdates`; ретрай по числовому chat_id :193).
- Без токена (`telegram-bot.service.ts:107`) код генерируется, но не отправляется —
  задокументированная деградация для локальной разработки/CI (см. `.env.example`).

### Пункт 9 — `TELEGRAM_BOT_TOKEN` в `.env.example`

**ПОДТВЕРЖДЕНО.** `.env.example:52` (`TELEGRAM_BOT_TOKEN=`) с подробным комментарием
(:44–51) о режиме работы, получении токена и требовании отсутствия webhook для
`getUpdates`. Дополнительно `TELEGRAM_API_BASE_URL` (:54).

### Пункт 10 — по каждому оставшемуся `.mjs`: дубликат (удалить) или пропуск (портировать)

См. полную сводную таблицу ниже. После issue #191 отдельные
`communication-core-m4.mjs` и `communication-core-m5.mjs` удалены: их production
логика портирована в `.ts`, а совместимость для старых `.mjs` contract/e2e тестов
временно сохранена в `communication-core/index.mjs`.

**Важное ограничение по удалению:** дубликаты-`.mjs` всё ещё импортируются ~25
`.mjs`-тестами (`services/backend/test/**/*.test.mjs`, `tests/e2e/*.test.mjs`,
`tests/integration/*.test.mjs`, `tests/contract/*.test.mjs`), которые исполняются
`node --test`. Поэтому физическое удаление исходных `.mjs` требует **скоординированной
миграции/удаления этих тестов** и в этот PR не входит (иначе рушится существующая
`.mjs`-тестовая гарантия). Вердикты «удалить» зафиксированы как решение; исполнение —
отдельной задачей вместе с миграцией `.mjs`-тестов на проверку `dist/main.js`
(см. пункт 12).

### Пункт 11 — build-script `find src -name '*.mjs' … node --check`

**ИСПРАВЛЕНО.** Из production-скрипта `build`
(`services/backend/package.json`) убран `find src -name '*.mjs' … node --check`:
он лишь синтаксически проверял мёртвый прототип и создавал ложное впечатление, что
`.mjs` — часть prod-сборки. Теперь `build` = `tsc -p tsconfig.build.json &&
node dist/tools/export-openapi.js`. Синтаксическая проверка `.mjs` осталась в `lint`
(гигиена исходников, покрывает и `.mjs`-тесты), а реальное исполнение `.mjs` —
в `test` (`node --test test/`).

### Пункт 12 — e2e прогоняются против собранного `dist/main.js` в Docker, не `.mjs`/моков

**ЧАСТИЧНО / ЗАФИКСИРОВАН ГЭП.**
- Production-артефакт корректен: Docker запускает `node dist/main.js`
  (`deploy/docker/backend/Dockerfile:21`), т.е. собранный NestJS.
- Однако существующие `.mjs`-e2e/contract/integration-тесты поднимают backend через
  прототип `createBackendServer` из `src/main.mjs`, а не `dist/main.js`. Затронуты в т.ч.
  `tests/e2e/web-chat-cp1.test.mjs:4`, `tests/e2e/telegram-cp2.test.mjs`,
  `tests/integration/communication-core-m1..m5.test.mjs` и др. (всего ~25 файлов
  импортируют `src/main.mjs`/`communication-core/index.mjs`/`mock-ingress-egress.mjs`).
  Эти тесты валидируют `.mjs`-прототип, а не production-код — источник ложной уверенности.
- **Восполнено для messaging-пути:** `test/integration/internal-messaging.spec.ts`
  поднимает **реальный** `AppModule` (тот же код, что и `dist/main.js`) на реальном
  Postgres (testcontainers) и проверяет ingress/egress/delivery, C9 edge tunnel,
  C8 broadcast delivery, adapter failure retry/degradation и `/metrics` load-probe
  counters end-to-end.
- **Вывод:** полная миграция ~25 `.mjs`-тестов на прогон против `dist/main.js` в Docker —
  отдельная крупная задача; зафиксирована как требующая выполнения вместе с удалением
  дубликатов-`.mjs` (пункт 10).

### Пункт 13 — документация отражает реальное состояние кода, не `.mjs`-прототипы

**ИСПРАВЛЕНО частично (см. правки docs).**
- `docs/plan/services/03-communication-core.md`: разделы M4/M5 обновлены: указано,
  что production-путь теперь реализован в NestJS `.ts`, а `.mjs` остался только как
  test compatibility barrel (`index.mjs`) для старых contract/e2e сценариев.
- Ссылки на `.mjs` в docs других сервисов (integration-platform, ai-platform) корректны:
  те сервисы реально исполняются как `.mjs` (это не NestJS-backend).

---

## Сводная таблица по `.mjs` (пункт 10)

| `.mjs`-файл | Вердикт | Исполняемый `.ts`-эквивалент / причина |
|---|---|---|
| `main.mjs` | удалить | `main.ts` + `bootstrap.ts` (NestFactory, версионирование, префикс) |
| `common/auth/session-auth-guard.mjs` | удалить | `common/auth/session-auth.guard.ts` (`SessionAuthGuard`, `extractSessionToken`, `requestedOrganizationId`) |
| `backend-api/m0-api-module.mjs` | удалить | `modules/health/health.controller.ts` + `health.service.ts` |
| `communication-core/communication-core-m1.mjs` | удалить | `internal-messaging.{service,dto,controller}.ts`, `message-status.ts`, `communication-core-proxy.service.ts` |
| `communication-core/communication-core-m4.mjs` | удалён (портировано) | `communication-core-m4.dto.ts`, `edge-intake.service.ts`, `internal-messaging.service.ts` |
| `communication-core/communication-core-m5.mjs` | удалён (портировано) | `communication-core-m5.service.ts`, `ai-degradation.guard.ts`, `metrics.service.ts` |
| `communication-core/communication-core-module.mjs` | удалить | `internal-messaging.controller.ts` + `communication-core.controller.ts`; ошибки → `api-exception.filter.ts` |
| `communication-core/index.mjs` | удалить | barrel-реэкспорт, в prod не используется (DI-модули Nest) |
| `communication-core/mock-ingress-egress.mjs` | удалить | тестовый мок; реальный путь → `internal-messaging.service.ts` |
| `identity/dto/auth-dto.mjs` | удалить | `telegram-auth.dto.ts` + `identity-m4.dto.ts` |
| `identity/identity-controller.mjs` | удалить | `telegram-auth.controller.ts`, `identity-m4.controller.ts`, `user.controller.ts` (logout) |
| `identity/identity-module.mjs` | удалить | `telegram-auth.module.ts` + `identity-m4.module.ts` |
| `identity/identity-service.mjs` | удалить (гэп: rate-limit 429) | `telegram-auth.service.ts`, `identity-m4.service.ts`, `audit.service.ts`, `session-auth.guard.ts`; **rate-limiting login start/verify не портирован** |
| `identity/seeded-auth-context.mjs` | удалить | прототипный сид, не нужен при Postgres |

## Открытые задачи (требуют отдельного портирования)

1. **M4** — Edge Intake Coordinator (C9) и Broadcast Delivery Coordinator (C8) в NestJS.
2. **M5** — Adapter Failure Coordinator, AI Degradation Guard, Load Probe в NestJS с
   подключением к реальному message-пути.
3. **Rate-limiting (429)** на `POST /auth/login/telegram/start` и `/verify`.
4. **Миграция `.mjs`-тестов** (e2e/contract/integration) на прогон против `dist/main.js`
   в Docker и последующее удаление дубликатов-`.mjs` (пункты 10, 12).
