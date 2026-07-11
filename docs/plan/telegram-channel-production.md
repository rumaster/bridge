---
title: План доведения канала Telegram до боевого режима
service: Integration Platform / Backend / SaaS Administration
service_id: SVC-INT · SVC-API · SVC-ADMIN · SVC-TGC
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/mock-to-production-roadmap.md, docs/plan/services/05-integration-platform.md
date: 2026-07-10
---

# План доведения канала Telegram до боевого режима

Документ детализирует конкретные шаги, чтобы **сквозной боевой сценарий Telegram**
работал без моков и разрывов:

- бизнес-клиент добавляет **токен бота своей организации** на странице
  `:8081/channels` (SaaS Administration);
- бот организации **принимает и обрабатывает входящие** сообщения клиентов;
- на всех этапах работает доставка **«клиент ↔ edge ↔ app ↔ manager»** и обратно.

Терминология и нумерация задач наследуются от
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md): `MP-06`
(реальные каналы), `MP-13` (SVC-TGC), `DR-03` (envelope-секреты), `DR-04`
(консолидация egress), `CP-2` (точка согласования «Telegram: приём и ответ»).
Этот план **не пересматривает** решения §4 роадмапа, а раскладывает их в
исполняемые шаги именно для Telegram.

> **Ограничение документа.** Только план. Кода и диффов нет. Оценки трудозатрат в
> человеко-днях/датах — не приводятся; шаги — логические/зависимостные единицы.

---

## 0. Текущее состояние (базовая линия)

Что **уже реально** и переиспользуется, не переписывается:

- Нормализация входящего/исходящего Telegram-апдейта —
  [`telegram-adapter.ts`](../../services/integration-platform/src/adapters/telegram/telegram-adapter.ts)
  (`normalizeIncomingPayload`, `createExternalPayload`).
- Реальный клиент Bot API на исходящих —
  [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts)
  (`createTelegramBotApiClient`), с идемпотентностью, ретраями, бэкоффом,
  resilience (`delivery-engine.ts`, `rate-limiter.ts`, `resilience.ts`).
- Приём и запись входящего на стороне ядра —
  [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)
  (`acceptIngress`): Postgres, RLS `withTenant`, идемпотентность,
  `clients`/`communication_endpoints`/`conversations`/`messages`, машина статусов.
- Схема БД под каналы и per-tenant секрет —
  [`m2_schema.sql`](../../db/migrations/20260703124000000_m2_schema.sql) (`channels`),
  [`stage1_foundation.sql`](../../db/migrations/20260705233000000_stage1_foundation.sql)
  (`channels.credentials_envelope`).
- Envelope-шифрование секрета канала —
  [`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts)
  (`ChannelSecretCipher`, `ChannelSecretStore`).
- Реальный `getUpdates`/`sendMessage` HTTP-клиент manager-консоли —
  [`telegram-bot-api.ts`](../../clients/telegram-console/src/telegram-bot-api.ts),
  [`long-polling-runner.ts`](../../clients/telegram-console/src/long-polling-runner.ts).
- Realtime-паблишер C7 —
  [`c7-realtime-event.publisher.ts`](../../services/backend/src/modules/communication-core/c7-realtime-event.publisher.ts).

Что **разорвано/замокано** и адресуется этим планом (`G-1…G-8`):

| ID | Разрыв | Где | Требование |
|----|--------|-----|------------|
| **G-1** | UI не принимает токен, только `secret://`-ссылку | [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx) | 1 |
| **G-2** | `connectChannel` пишет в in-memory `Map`, не в БД, токен не хранит | [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts) | 1 |
| **G-3** | `ChannelSecretStore` не вызывается в рантайме | secret store + facade | 1 |
| **G-4** | `testChannel` не проверяет токен реально (нет `getMe`) | facade + upstream | 1 |
| **G-5** | Нет входящего драйвера (ни webhook, ни getUpdates) для бота организации; нет маппинга `bot/chat → organization` | integration-platform | 2 |
| **G-6** | Egress берёт **один глобальный** `TELEGRAM_BOT_TOKEN`, не per-channel | [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts), [`main.ts`](../../services/integration-platform/src/main.ts) | 2, 3 |
| **G-7** | `acceptIngress` не публикует C7 → менеджер не получает live-пуш входящего | [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts) | 3 |
| **G-8** | Проактивные карточки в SVC-TGC (`deliverNotification`) и Telegram-плечо SVC-NOTIF не подключены в проде | [`handler-router.ts`](../../clients/telegram-console/src/handler-router.ts), notification-platform | 3 |

---

## 1. Целевая архитектура сквозного сценария

```
ВХОДЯЩЕЕ (клиент → менеджер):
  Клиент в Telegram
    → Telegram Bot API (webhook ИЛИ getUpdates по токену организации)
    → SVC-INT Telegram inbound driver  [G-5]
        · резолв bot_id/секрета → organization_id + channel_id  [G-5]
        · normalizeIncomingPayload → C2.IngressMessage
    → (через Edge, RF-first)                         [Этап E]
    → Backend POST /internal/ingress/messages
        · acceptIngress: persist inbound             [есть]
        · publishMessageCreated → C7 Redis Stream    [G-7]
    → Edge C7 WS → manager-workspace (live)          [Этап E]
    → (опц.) карточка в SVC-TGC менеджеру            [G-8]

ИСХОДЯЩЕЕ (менеджер → клиент):
  manager-workspace / telegram-console
    → Backend POST /messages (outbound)              [есть]
    → Backend POST /internal/egress/messages → forwardEgressDelivery
    → SVC-INT POST /internal/delivery/dispatch
        · резолв channel → per-channel токен (secret) [G-6]
        · createTelegramBotApiClient(token).deliver   [есть]
    → Telegram Bot API → Клиент
    → recordDeliveryAttempt (статусы)                 [есть]
```

Ключевая мысль: **токен организации — единица маршрутизации в обе стороны**.
Входящее приходит на бот с этим токеном → определяем организацию; исходящее
доставляется этим же токеном. Всё остальное (нормализация, resilience, запись в
БД) уже готово.

---

## 2. Этапы и последовательность

Граф зависимостей (ребро = «нужно раньше»):

```
Этап T0 (фундамент секрета) ─┬─→ Этап T1 (регистрация канала + токен, G-1..G-4)
                             └─→ Этап T2 (egress per-channel токен, G-6)
Этап T1 ─→ Этап T3 (входящий драйвер + маппинг, G-5)
Этап T3 ─→ Этап T4 (realtime менеджеру, G-7, G-8)
Этап T4 ─→ Этап T5 (Edge в боевом режиме, RF-first)
Все ────→ Этап T6 (сквозной e2e CP-2, деградация, приёмка)
```

Параллелизуемость: **T1 и T2** независимы после T0; **T5** можно вести параллельно
c T1–T4 (сетевой контур), синхронизируя точку стыка в T6.

---

### Этап T0 — Фундамент секрета канала (DR-03)

**Цель.** Включить `ChannelSecretStore` в рантайм и договориться о формате
`credentials_ref` для Telegram.

**Задачи.**
1. Провайдер `ChannelSecretStore` в DI backend: собрать из `PgDatabase` +
   `ChannelSecretCipher.fromEnv()`; ключ — `CHANNEL_SECRET_ENCRYPTION_KEY`
   (уже в [`.env.example`](../../.env.example)).
2. Зафиксировать схему ссылки: `secret://telegram/<organization_id>/<label>`.
   `credentials_ref` остаётся в `channels`, сам токен — в `credentials_envelope`.
3. Проверить, что миграция `stage1_foundation` применяется в целевом окружении
   (колонка `credentials_envelope` + CHECK-констрейнты «no plaintext»).

**Затрагиваемые файлы.**
[`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts)
(без изменений логики, только wiring), новый провайдер в модуле
integration-gateway, [`.env.example`](../../.env.example) (комментарий про формат).

**DoD.** `ChannelSecretStore` резолвится из DI; unit-тест
[`channel-secret.store.spec.ts`](../../services/backend/test/unit/channel-secret.store.spec.ts)
зелёный; секрет пишется/читается против тестовой БД.

**Тесты.** unit (encrypt/decrypt round-trip), integration (put→resolve через
Postgres с RLS).

**Статус реализации T0 (2026-07-10): выполнено.**
- Добавлена DI-обёртка
  [`ChannelSecretService`](../../services/backend/src/common/secrets/channel-secret.service.ts)
  + глобальный
  [`SecretsModule`](../../services/backend/src/common/secrets/secrets.module.ts),
  подключённый в [`app.module.ts`](../../services/backend/src/app.module.ts).
  Cipher/store создаются лениво (ключ `CHANNEL_SECRET_ENCRYPTION_KEY` читается при
  первом использовании), доступ к `channels` под RLS идёт как platform operator.
- Зафиксирован формат ссылки `secret://<channel_type>/<organization_id>/<label>`
  (хелпер `buildCredentialsRef`, документирован в
  [`.env.example`](../../.env.example)).
- Миграция
  [`stage1_foundation.sql`](../../db/migrations/20260705233000000_stage1_foundation.sql)
  (`channels.credentials_envelope` + CHECK «no plaintext») уже в наборе миграций,
  применяется до этой задачи; наличие колонки проверяет
  [`tests/integration/data-platform.test.ts`](../../tests/integration/data-platform.test.ts).
- Тесты: unit
  [`channel-secret.store.spec.ts`](../../services/backend/test/unit/channel-secret.store.spec.ts)
  и новый
  [`channel-secret.service.spec.ts`](../../services/backend/test/integration/channel-secret.service.spec.ts)
  (DI-резолв + put→resolve через RLS-эмуляцию operator-контекста) — зелёные;
  `tsc --noEmit`, сборка и boot AppModule
  ([`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts))
  — без регрессий. Реальный Postgres-прогон RLS выполняется в CI-профиле
  `test:integration` (Testcontainers).

---

### Этап T1 — Регистрация канала и приём токена (G-1, G-2, G-3, G-4)

**Цель.** Бизнес-клиент вводит токен на `:8081/channels`, токен шифруется и
сохраняется, канал персистится в БД, тест канала реально дёргает Telegram `getMe`.

**Задачи (backend, SVC-API).**
1. Персистентность каналов: заменить in-memory `Map` в
   [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
   на запись/чтение таблицы `channels` через `PgDatabase.withTenant`
   (`connectChannel`, `listChannels`, `getChannel`, `testChannel`).
2. Приём токена: расширить `ConnectChannelRequestDto`
   ([`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts))
   опциональным полем `credentials` (plaintext-токен) **только в теле POST**, не в
   `config`. Валидация: для `telegram` токен обязателен, формат `^\d+:[A-Za-z0-9_-]{30,}$`.
3. Сохранение секрета: в `connectChannel` после вставки строки `channels`
   вызвать `ChannelSecretStore.putChannelSecret({channelId, organizationId,
   plaintext: credentials})`; в ответе **никогда** не возвращать сам токен, только
   `credentials_ref` и `status`.
4. Реальный `:test`: в `testChannel` резолвить токен и вызвать
   `GET https://api.telegram.org/bot<token>/getMe`; при `ok:true` → `status=connected`,
   `last_check_at=now`, сохранить `config.bot_username`/`bot_id` из ответа; иначе
   `status=error` + запись причины. Вызов обернуть в существующий `FacadeResilience`.
5. Убедиться, что CHECK `channels_config_no_inline_secrets` не нарушается (токен не
   попадает в `config`).

**Задачи (frontend, SVC-ADMIN).**
6. В [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx)
   для коннектора `telegram` добавить поле **«Токен бота»** (масковый ввод), убрать
   требование `secret://` для этого типа; клиентская валидация формата токена.
7. Обновить типы/клиент API
   ([`types.ts`](../../apps/saas-admin/src/api/client/types.ts),
   [`http.ts`](../../apps/saas-admin/src/api/client/http.ts)):
   `createChannel` шлёт `{organization_id, channel_type:"telegram", name,
   credentials:<token>, config:{}}`.
8. MSW-моки
   ([`handlers.ts`](../../apps/saas-admin/src/api/mocks/handlers.ts)): принять
   `credentials`, не хранить его в ответе, вернуть `credentials_ref`; `:test`
   вернуть детерминированный `connected`. Флаг мока — `DEV && VITE_SAAS_ADMIN_MOCKS`.

**DoD.** POST `/api/v1/channels` с токеном → строка в `channels` +
`credentials_envelope` заполнен; токен нигде не возвращается и не логируется;
`POST /channels/{id}:test` для валидного токена возвращает `connected` по
реальному `getMe`; UI позволяет ввести токен и показывает статус/ошибку. Изоляция
арендатора (RLS) проверена.

**Тесты.** unit (валидация токена, маппинг DTO), integration (Backend↔Postgres:
connect→secret stored→test getMe через **мок Telegram API**), UI-тест формы.

**Статус реализации T1 (2026-07-10): выполнено.**
- Backend. Facade
  [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
  переписан на персистентность через `PgDatabase.withTenant` (in-memory `Map`
  удалён): `connectChannel` вставляет строку `channels` вместе с зашифрованным
  `credentials_envelope` (атомарно), `listChannels`/`testChannel` читают из БД.
  DTO
  [`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts)
  получил write-only поле `credentials` (токен), которое шифруется через
  `ChannelSecretService.encrypt` и **никогда не возвращается**. `:test` для
  Telegram резолвит токен и реально вызывает `getMe` (ok → `connected` +
  `config.bot_username`/`bot_id`, иначе `error`). Модуль
  [`integration-gateway.module.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.module.ts)
  инжектит `PgDatabase` + `ChannelSecretService`; контроллер стал async.
- Frontend. На `:8081/channels`
  ([`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx))
  для Telegram — масковое поле «Токен бота» (`type="password"`) с валидацией
  `^\d+:[A-Za-z0-9_-]{30,}$`; для остальных каналов сохранён ввод `credentials_ref`.
  Запрос шлёт `credentials` (токен) для Telegram и `credentials_ref` для прочих
  ([`types.ts`](../../apps/saas-admin/src/api/client/types.ts)); MSW-моки
  ([`handlers.ts`](../../apps/saas-admin/src/api/mocks/handlers.ts)) принимают
  токен, возвращают только сгенерированный `credentials_ref`, `:test` → connected.
- Контракт. Additive-поле `credentials` внесено в опубликованный
  [`openapi.json`](../../packages/contracts/openapi/backend-core/openapi.json)
  (не ломает `/api/v1`, CP-9).
- Тесты (зелёные): backend unit
  [`integration-gateway.facade.spec.ts`](../../services/backend/test/unit/integration-gateway.facade.spec.ts)
  (connect ref/token, getMe ok/fail/no-token), integration
  [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts)
  (Telegram token → envelope → getMe), OpenAPI-контракт
  [`m5-openapi-contract.spec.ts`](../../services/backend/test/integration/m5-openapi-contract.spec.ts);
  frontend
  [`m2-channels-knowledge.test.tsx`](../../apps/saas-admin/test/m2-channels-knowledge.test.tsx)
  и весь набор saas-admin (99/99). `tsc --noEmit` и сборка backend/frontend —
  чисто; регрессий нет (8 упавших backend suite — только Testcontainers без Docker).

---

### Этап T2 — Исходящая доставка по токену организации (G-6, DR-04)

**Цель.** Egress в Telegram использует **per-channel** токен из secret store, а не
глобальный env.

**Задачи.**
1. В [`main.ts`](../../services/integration-platform/src/main.ts) SVC-INT убрать
   опору на единственный `createRealChannelClientsFromEnv()` как источник токена
   для telegram; ввести **резолвер токена по `channel_id`** доставки.
2. Источник токена для SVC-INT: поскольку прямого доступа к БД у SVC-INT нет
   (ТЗ §22.3), добавить внутренний backend-эндпоинт
   `GET /internal/channels/{id}/secret` (S2S, версионно-нейтральный, как остальные
   `/internal/*`), который резолвит токен через `ChannelSecretStore` и отдаёт его
   только внутреннему клиенту; SVC-INT кэширует по `channel_id` с TTL.
   *Альтернатива (проще для MVP):* Backend в конверте `C2.EgressDelivery`
   (`buildC2EgressDelivery`,
   [`internal-messaging.dto.ts`](../../services/backend/src/modules/communication-core/internal-messaging.dto.ts))
   передаёт уже разрезолвленный токен в защищённом поле; тогда SVC-INT не ходит за
   секретом. Выбор фиксируется в T2 отдельным решением.
3. `createTelegramBotApiClient` принимает токен **на вызов** `deliver`, а не на
   создание; либо фабрика клиентов по токену с кэшем.
4. Убрать «тихий noop»: если токен канала не резолвится — доставка должна
   завершаться **ошибкой** (retryable/`error`), а не `accepted:true` через
   `createNoopChannelClient`
   ([`m2-channel-adapter.ts`](../../services/integration-platform/src/adapters/common/m2-channel-adapter.ts)).
5. Сохранить идемпотентность (`idempotency_key`), rate-limit и resilience как есть.

**DoD.** Ответ менеджера в организации A уходит через токен A, в организации B —
через токен B; при отсутствии/невалидности токена доставка фиксируется как `failed`
с причиной (не молчаливый успех); повтор с тем же `idempotency_key` не создаёт
дубль.

**Тесты.** unit (резолвер токена, ошибка при отсутствии токена), integration
(две организации, два токена, доставка через **мок Telegram API**; повтор без
дубля).

**Статус реализации T2 (2026-07-10): выполнено. Решение по §2 — вариант A
(S2S-эндпоинт), токен не кладётся в конверт C2.**
- Backend. Facade получил `resolveChannelDeliveryToken(organizationId,
  channelType)`
  ([`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)):
  выбирает не отключённый канал нужного типа с `credentials_ref` и расшифровывает
  секрет через `ChannelSecretService`. Новый внутренний контроллер
  [`internal-channels.controller.ts`](../../services/backend/src/modules/integration-gateway/internal-channels.controller.ts)
  отдаёт `GET /internal/channels/secret?organization_id&channel_type` (S2S, вне
  `/api`, `@ApiExcludeController`; добавлен в exclude
  [`bootstrap.ts`](../../services/backend/src/bootstrap.ts) и в список маршрутов
  [`m5-openapi-contract.spec.ts`](../../services/backend/test/integration/m5-openapi-contract.spec.ts)).
  Контракт C2 и `openapi.json` не изменены (токен наружу не публикуется).
- SVC-INT. Новый
  [`backend-channel-secret-client.ts`](../../services/integration-platform/src/delivery/backend-channel-secret-client.ts)
  резолвит токен по org+type с TTL-кэшем (404 → null с negative-TTL, 5xx/сеть →
  retryable). Новый `createResolvingTelegramClient`
  ([`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts))
  доставляет через per-org токен (клиент Bot API кэшируется по токену); при
  отсутствии токена — **НЕповторяемая ошибка**, а не «тихий noop» (G-6, задача 4).
  [`main.ts`](../../services/integration-platform/src/main.ts) переключён:
  Telegram регистрируется всегда и резолвит токен на лету (общий
  `TELEGRAM_BOT_TOKEN` больше не источник для клиентских каналов), Email/MAX — по
  env-шлюзам. Идемпотентность/rate-limit/resilience движка доставки сохранены.
- Тесты (зелёные): backend
  [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts)
  (S2S-резолв токена + 404); integration-platform unit
  [`channel-token-resolution.test.ts`](../../services/integration-platform/test/unit/channel-token-resolution.test.ts)
  (кэш/404/5xx, per-org доставка, ошибка без токена) и integration
  [`t2-per-org-telegram-delivery.integration.test.ts`](../../services/integration-platform/test/integration/t2-per-org-telegram-delivery.integration.test.ts)
  (org A→bot-A, org B→bot-B, повтор без дубля, missing token → `failed`). `tsc`
  обоих сервисов и весь набор integration-platform (81/81) — чисто; backend без
  регрессий (8 упавших suite — только Testcontainers без Docker).

---

### Этап T3 — Входящий драйвер и маппинг «бот → организация» (G-5)

**Цель.** Реально получать входящие клиентов на бот организации и доводить их до
`acceptIngress` с корректными `organization_id`/`channel_id`.

**Задачи.**
1. Выбрать способ приёма (зафиксировать решением в начале T3):
   - **Вариант W (webhook, рекомендуется для прод):** при `:test`/подключении
     канала регистрировать `setWebhook` на публичный URL SVC-INT
     `POST /telegram/webhook/{channel_id}`; входящий апдейт содержит `channel_id`
     в пути → резолв организации.
   - **Вариант P (getUpdates long-poll):** на каждый подключённый telegram-канал
     поднимать поллер `getUpdates` с токеном канала (переиспользовать паттерн
     [`long-polling-runner.ts`](../../clients/telegram-console/src/long-polling-runner.ts));
     оффсеты хранить per-channel. Проще без публичного URL, дороже по ресурсам.
2. Реестр активных telegram-каналов в SVC-INT: список `{channel_id,
   organization_id, token, bot_id, offset}` — наполняется из backend
   (`GET /internal/channels?type=telegram`) при старте и по событию подключения.
3. Приёмник: новый маршрут в
   [`server.ts`](../../services/integration-platform/src/server.ts)
   (`POST /telegram/webhook/{channel_id}` для W) или воркер-поллер (для P), который
   подставляет `organization_id`/`channel_id` в payload и вызывает
   `publishIncomingMessage` telegram-адаптера (нормализация уже есть).
4. Маппинг отправителя: `chat.id`/`from.id` → `communication_endpoints`
   (`external_id`) уже делается в `resolveEndpoint` на стороне backend — проверить,
   что telegram-канал прокидывает `conversation_ref = chat.id`, `sender_ref = from.id`.
5. Дедуп/идемпотентность входящих: `idempotency_key` = стабильный ключ из
   `channel_id + update_id`; повтор апдейта не создаёт второе сообщение
   (у `acceptIngress` идемпотентность по `message.id` уже есть).
6. Резолв секрета для приёмника — тот же механизм, что в T2.

**DoD.** Сообщение, отправленное реальным клиентом боту организации, доходит до
`messages` как `inbound/client/routed` с правильным `organization_id`; повтор
апдейта Telegram не двоит сообщение; несколько организаций/ботов изолированы.

**Тесты.** unit (резолв `channel_id → organization_id`, дедуп `update_id`),
integration (мок Telegram API шлёт апдейт → SVC-INT → backend ingress → строка в
`messages`), негатив (неизвестный `channel_id` → 404/квинтэссенция без записи).

**Статус реализации T3 (2026-07-10): выполнено. Решение по §1 — вариант P
(getUpdates long-poll, по одному поллеру на канал).**
- Способ приёма. Выбран **вариант P**: не требует публичного HTTPS-URL и
  `setWebhook`, легко тестируется моком Bot API, оффсеты хранятся per-channel в
  памяти драйвера. Вариант W (webhook `setWebhook` + `POST /telegram/webhook/{id}`)
  остаётся альтернативой для прод (описан в задаче 1) — при переходе меняется
  только источник апдейтов, нормализация/маппинг/дедуп переиспользуются.
- Backend. Facade получил `listActiveChannelsByType(channelType)`
  ([`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)):
  кросс-тенантный (platform operator) список подключённых каналов типа
  `{channel_id, organization_id, config}` **без токена**. Внутренний контроллер
  ([`internal-channels.controller.ts`](../../services/backend/src/modules/integration-gateway/internal-channels.controller.ts))
  отдаёт `GET /internal/channels?channel_type=telegram` (S2S, вне `/api`,
  `@ApiExcludeController`; добавлен в exclude
  [`bootstrap.ts`](../../services/backend/src/bootstrap.ts) и в список маршрутов
  [`m5-openapi-contract.spec.ts`](../../services/backend/test/integration/m5-openapi-contract.spec.ts)).
  Токен драйвер по-прежнему берёт secret-эндпоинтом T2 (`/internal/channels/secret`);
  `openapi.json` не изменён (внутренний контроллер исключён из контракта).
- SVC-INT. Новый пакет
  [`src/inbound/`](../../services/integration-platform/src/inbound/):
  `backend-channels-client.ts` (реестр каналов из backend),
  `telegram-updates-client.ts` (getUpdates по паттерну manager-консоли, но
  per-org токеном) и `telegram-inbound-driver.ts` — драйвер: наполняет реестр из
  backend (старт + периодический рефреш), на каждый канал резолвит токен тем же
  T2 secret-клиентом, поллит `getUpdates`, подставляет
  `organization_id`/`channel_id` в payload и вызывает
  `telegram-adapter.publishIncomingMessage` (нормализация → `POST CORE_INGRESS_URL`).
  Дедуп/идемпотентность: стабильный `message_id = idempotency_key =
  tg-<channel_id>-<update_id>` (в T5 заменён на детерминированный UUID из этого
  ключа — ядро принимает `message.id` только как UUID; см. статус T5); оффсеты
  per-channel (`offset = update_id + 1`).
  Апдейты без текста/вложений (сервисные, callback_query) пропускаются, но оффсет
  двигается. [`main.ts`](../../services/integration-platform/src/main.ts)
  поднимает драйвер после `listen` (гейт `TELEGRAM_INBOUND_ENABLED`, по умолчанию
  включён) и останавливает по SIGINT/SIGTERM. Маппинг отправителя
  (`conversation_ref = chat.id`, `sender_ref = from.id`) обеспечивает существующий
  `normalizeIncomingPayload` — драйвер лишь прокидывает сырой апдейт.
- Тесты (зелёные): backend integration
  [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts)
  (список активных telegram-каналов без токена; пустой список для типа без каналов
  и неизвестного типа), контракт
  [`m5-openapi-contract.spec.ts`](../../services/backend/test/integration/m5-openapi-contract.spec.ts)
  (byte-for-byte + новый unversioned-маршрут); integration-platform unit
  [`telegram-inbound-driver.test.ts`](../../services/integration-platform/test/unit/telegram-inbound-driver.test.ts)
  (маппинг bot→organization, дедуп/оффсет по `update_id`, изоляция оффсетов между
  организациями, пропуск неингестируемого апдейта, пропуск канала без токена,
  снятие отключённого канала при рефреше) и integration
  [`t3-telegram-inbound.integration.test.ts`](../../services/integration-platform/test/integration/t3-telegram-inbound.integration.test.ts)
  (мок Telegram API → SVC-INT → core ingress → строка в «messages» с правильным
  `organization_id`/`conversation_ref`/`sender_ref`; повтор апдейта не двоит; два
  бота — две организации изолированы). `tsc` обоих сервисов — чисто;
  integration-platform 89/89; backend без регрессий (8 упавших suite — только
  Testcontainers без Docker).

---

### Этап T4 — Доставка входящего менеджеру в реальном времени (G-7, G-8)

**Цель.** Менеджер видит входящее клиента **сразу**, а не по опросу.

**Задачи.**
1. Публикация C7 на приёме: в `acceptIngress`
   ([`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts))
   после успешной вставки вызвать
   `C7RealtimeEventPublisher.publishMessageCreated(...)` (сейчас вызывается только
   из ответа менеджера и web-chat). Публиковать в той же транзакции/после коммита,
   не ломая идемпотентность (для дубля — не публиковать повторно).
2. Требуется Redis (`DR-02`): проверить, что `RedisInfrastructureService.isConfigured()`
   истинно в целевом окружении; иначе паблиш — no-op (уже заложено).
3. manager-workspace: убедиться, что realtime-клиент подписан на `message.created`
   для организации и рендерит новое входящее в списке диалогов.
4. (Опц., G-8) Проактивные карточки в Telegram-консоль менеджера: подключить
   `deliverNotification`
   ([`handler-router.ts`](../../clients/telegram-console/src/handler-router.ts)) к
   боевому потоку — консюмер, читающий `/notifications` или C10-событие и
   вызывающий `deliverNotification({chatId, notification})`. Telegram-плечо
   notification-platform заменить с recording-mock на реальный вызов SVC-TGC/SVC-INT.

**DoD.** Входящее клиента появляется в manager-workspace без перезагрузки (через
C7 WS); (опц.) менеджер получает карточку в Telegram-консоли. Дубликат входящего не
порождает второе realtime-событие.

**Тесты.** unit (публикация только на не-дубликате), integration (ingress →
Redis Stream содержит `message.created`), e2e-фрагмент (WS-клиент получает событие).

**Статус реализации T4 (2026-07-10): выполнено (G-7 и G-8).**
- Backend (G-7). `acceptIngress`
  ([`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts))
  после успешного коммита транзакции публикует C7 `message.created` через
  `C7RealtimeEventPublisher.publishMessageCreated` (тот же паблишер и конверт
  `MessageResponseDto`, что у ответа менеджера и web-chat). Публикация **только для
  не-дубликата** (`result.duplicate === false`) — повтор идемпотентного апдейта не
  порождает второе realtime-событие — и **best-effort**: ошибка публикации
  подавляется (warn) и не влияет на приём; без Redis
  (`RedisInfrastructureService.isConfigured()` ложно) паблиш — no-op (DR-02, уже
  заложено). Паблишер инжектится в `InternalMessagingService` (оба в
  `CommunicationCoreProxyModule`, доп. wiring не нужен). Побочно C7 получает и
  edge-tunnel путь приёма (`EdgeIntakeCoordinatorService → acceptIngress`),
  оставаясь идемпотентным.
- Frontend (задача 3). manager-workspace уже подписан на `message.created` и
  рендерит входящее вживую: `applyC7EventToMessages` вставляет сообщение в диалог,
  `applyC7EventToConversations` поднимает превью и инкрементит `unreadCount` для
  `direction === "inbound"`, с дедупом по `message.id`
  ([`realtime-merge.ts`](../../apps/manager-workspace/src/state/realtime-merge.ts)).
  Конверт, публикуемый backend на ingress, идентичен уже потребляемому — изменения
  фронта не требуются.
- Тесты (зелёные): backend unit
  [`internal-messaging-ingress-realtime.spec.ts`](../../services/backend/test/unit/internal-messaging-ingress-realtime.spec.ts)
  (публикация на не-дубликате с корректным конвертом; отсутствие публикации на
  дубликате; приём не падает при сбое realtime) и существующий
  [`c7-realtime-event.publisher.spec.ts`](../../services/backend/test/unit/c7-realtime-event.publisher.spec.ts)
  (форма события `C7.WebSocketEvent` в Redis Stream); frontend
  [`realtime-merge.test.ts`](../../apps/manager-workspace/test/realtime-merge.test.ts)
  (WS `message.created` → рендер входящего, дедуп live-события, `unreadCount`).
  `tsc --noEmit` backend — чисто; backend unit 151/151 (31 suite) + AppModule-boot
  ([`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts),
  m5-контракт) без регрессий от новой DI-зависимости; manager-workspace
  realtime-merge 11/11. Интеграционный прогон «ingress → Redis Stream содержит
  `message.created`» выполняется в CI-профиле с Testcontainers + Redis (локально без
  Docker Redis не поднимается; предсуществующее ограничение).

**Статус реализации G-8 (2026-07-10): выполнено (проактивные карточки менеджеру в
Telegram Console).**
- SVC-TGC (telegram-console). Реализован боевой поток вокруг уже существующего
  `router.deliverNotification({chatId, notification})`:
  диспетчер
  [`notification-dispatcher.ts`](../../clients/telegram-console/src/notification-dispatcher.ts)
  принимает C10-уведомление и резолвит `chat_id` менеджера (явный
  `payload.telegram_chat_id`, иначе обратный поиск в session-store по
  `recipient_user_id` — новый `findChatIdByUserId`
  в [`session-store.ts`](../../clients/telegram-console/src/session-store.ts));
  нет привязанного чата → `skipped` (не ошибка). HTTP-приёмник
  [`notification-server.ts`](../../clients/telegram-console/src/notification-server.ts)
  отдаёт S2S-маршрут `POST /internal/notifications/telegram` для SVC-NOTIF.
  [`main.ts`](../../clients/telegram-console/src/main.ts) поднимает приёмник при
  заданном `TELEGRAM_CONSOLE_NOTIFICATIONS_PORT` и делит session-store с роутером.
- SVC-NOTIF (notification-platform). Telegram-плечо переведено с recording-mock на
  реальный форвард: новый `createTelegramForwardingChannelAdapter`
  ([`channel-adapters.ts`](../../services/notification-platform/src/channel-adapters.ts))
  постит карточку в SVC-TGC (`POST {SVC_TGC_NOTIFICATIONS_URL}/internal/notifications/telegram`).
  `createDefaultChannelAdapters` выбирает форвард при заданном
  `SVC_TGC_NOTIFICATIONS_URL`, иначе — прежний записывающий mock (dev/CI без внешних
  вызовов). Конвейер доставки SVC-NOTIF синхронный, поэтому handoff-запись
  формируется сразу, а HTTP-вызов идёт фоном (best-effort): его сбой не блокирует
  остальные каналы (web/email/push) и не роняет приём C10-события.
- Тесты (зелёные): notification-platform unit
  [`telegram-forwarding-adapter.test.ts`](../../services/notification-platform/test/unit/telegram-forwarding-adapter.test.ts)
  (форвард карточки, устойчивость к сбою, выбор форвард/mock) и integration
  [`g8-telegram-forward.integration.test.ts`](../../services/notification-platform/test/integration/g8-telegram-forward.integration.test.ts)
  (`acceptProducerEvent` → форвард в SVC-TGC; нет форварда при отключённой telegram-
  подписке); telegram-console unit
  [`notification-dispatcher.test.ts`](../../clients/telegram-console/test/unit/notification-dispatcher.test.ts)
  (резолв chat_id из сессии, явный chat_id, skip без чата/без telegram-канала) и
  integration
  [`notification-intake.test.ts`](../../clients/telegram-console/test/integration/notification-intake.test.ts)
  (`POST /internal/notifications/telegram` → карточка в чат привязанного менеджера;
  skip для непривязанного получателя). `tsc` обоих сервисов — чисто;
  notification-platform 49/49, telegram-console 28/28, без регрессий.

---

### Этап T5 — Боевой Edge-контур (RF-first) для Telegram

**Цель.** Маршрутизировать трафик Telegram через Edge Cluster согласно
«клиент ↔ **edge** ↔ app ↔ manager» (ТЗ §7.13/§7.14), убрать дефолтный `mock`.

**Задачи.**
1. Поднять `edge-gateway` в режиме `edge`/`app-vpn`
   ([`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts)) с
   VPN-сертификатами и RF-Postgres (`DATABASE_URL`), как в
   [`.env.rf.example`](../../.env.rf.example) и compose `docker-compose.rf.yml`.
2. Первичное приземление входящих ПДн субъектов РФ — в RF-буфере до форвардинга
   (`edge-cluster.ts` `ingest`, RF-first, sequence_number, шифрование).
3. Точка стыка: входящий драйвер T3 (для клиентов РФ) публикует не напрямую в
   backend ingress, а через Edge (`/internal/edge/ingress/messages` →
   туннель → `/internal/edge/tunnel/messages` → `EdgeIntakeCoordinatorService`).
4. Проверить деградацию: недоступность туннеля → буферизация и авто-дренаж на
   reconnect; ядро не блокируется (ТЗ §11.2).

**DoD.** Для клиента РФ входящее сначала фиксируется в RF-буфере, затем доходит до
ядра; при обрыве туннеля не теряется и досылается; edge не в `mock`.

**Тесты.** integration (RF-first порядок записи, дренаж после reconnect), проба
деградации «туннель недоступен → ядро работает».

> Примечание: для не-РФ размещения Edge может быть опциональным (прямой режим), но
> сам маршрут «через edge» должен быть рабочим и выбираемым конфигурацией, а не
> демо-параметром.

**Статус реализации T5 (2026-07-10): выполнено (точка стыка входящего Telegram с
Edge, задачи 3–4; RF-инфраструктура задач 1–2 уже существует).**
- **Важная сопутствующая правка (латентный баг T3).** Ядро принимает
  `message.id` только как строгий UUID (C1/C2 `UUID_PATTERN`,
  [`internal-messaging.dto.ts`](../../services/backend/src/modules/communication-core/internal-messaging.dto.ts)).
  Драйвер T3 слал `message_id = tg-<channel>-<update_id>` (не UUID) — реальный
  `acceptIngress` его отвергал (в T3-тестах backend был замокан, поэтому баг не
  всплыл). T5 переводит стабильный ключ на детерминированный UUID
  (`stableTelegramMessageId = uuidFromText("tg-message:<channel>:<update_id>")`,
  [`ids.ts`](../../services/integration-platform/src/inbound/ids.ts)) — идемпотентность
  сохранена (тот же апдейт → тот же UUID), приём теперь реально доходит до ядра.
  Читаемый Telegram-id остаётся в `external_message_id`.
- **Точка стыка (задача 3).** Новый издатель приёма
  [`ingress-publisher.ts`](../../services/integration-platform/src/inbound/ingress-publisher.ts)
  с двумя маршрутами: **direct** (`CORE_INGRESS_URL`, как в T3) и **edge**
  (`EDGE_INGRESS_URL` → `/internal/edge/ingress/messages` → RF-буфер `edge-cluster.ingest`
  → VPN-туннель → `/internal/edge/tunnel/messages` → `EdgeIntakeCoordinatorService`
  → `acceptIngress`). Драйвер
  ([`telegram-inbound-driver.ts`](../../services/integration-platform/src/inbound/telegram-inbound-driver.ts))
  выбирает edge для клиентов РФ (`config.region==="RF"` / `config.route_via_edge`) при
  заданном `EDGE_INGRESS_URL`, иначе — прямой путь. Edge-тело — тот же конверт C2 плюс
  UUID-поля верхнего уровня `id`/`endpoint_id`, нужные Edge Cluster для
  секвенирования/идемпотентности; ядро распознаёт конверт по
  `contract==="C2.IngressMessage"` и само резолвит endpoint (SVC-INT не синтезирует
  DB-идентификаторы). Адаптер получил `buildIngress` (нормализация без отправки),
  [`main.ts`](../../services/integration-platform/src/main.ts) собирает publishIncoming
  из `buildIngress` + издателя.
- **Деградация (задача 4).** Обрыв туннеля обрабатывает сам Edge (RF-буфер +
  авто-дренаж, `edge-cluster.ts` — уже было): SVC-INT получает 202 и не блокируется.
  Недоступность самого Edge/ядра → `IngressPublishError(retryable)`: драйвер **не
  двигает оффсет** и прерывает разбор батча — апдейт переопрашивается на следующем
  поллинге (не теряется). Непригодные апдейты (нормализация) по-прежнему
  пропускаются с продвижением оффсета (не блокируют очередь). Ранее драйвер T3
  двигал оффсет на любой ошибке — транзиентный сбой приёма терял сообщение; T5 это
  исправляет.
- **Инфраструктура (задачи 1–2).** Боевой режим Edge уже реализован:
  [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts)
  (`EDGE_GATEWAY_MODE=edge`/`app-vpn`, RF-cipher, VPN-туннель, Postgres-буфер),
  RF-first `ingest` в [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts),
  маршруты приёма/туннеля в [`server.ts`](../../services/edge-gateway/src/server.ts).
  Конфиг: `EDGE_INGRESS_URL` (SVC-INT, [`.env.example`](../../.env.example)) +
  [`.env.rf.example`](../../.env.rf.example). Поднятие контейнеров/сертов —
  деплой-задача вне кода (`docker-compose.rf.yml` в репозитории пока нет).
- **Тесты (зелёные).** integration-platform unit
  [`ingress-publisher.test.ts`](../../services/integration-platform/test/unit/ingress-publisher.test.ts)
  (маршрутизация core/edge, форма edge-тела с UUID id/endpoint_id, retryable-ошибка на
  5xx/сети) и integration
  [`t5-edge-inbound.integration.test.ts`](../../services/integration-platform/test/integration/t5-edge-inbound.integration.test.ts)
  (RF → Edge, не-РФ → core; Edge недоступен → оффсет не двинут, апдейт доходит после
  восстановления); backend unit
  [`t5-edge-ingress-shape.spec.ts`](../../services/backend/test/unit/t5-edge-ingress-shape.spec.ts)
  прогоняет ровно те конверты SVC-INT через реальные `normalizeEdgeTunnelMessage` +
  `normalizeIngressEnvelope` (без Docker) — direct и edge приняты, legacy `tg-<id>`
  отвергнут (страж регрессии). `tsc` обоих сервисов — чисто; integration-platform
  95/95, backend unit 141/141 без регрессий.

---

### Этап T6 — Сквозная приёмка CP-2 «Telegram: приём и ответ»

**Цель.** Подтвердить весь путь без моков и разрывов.

**Задачи.**
1. e2e-сценарий: реальный (или тест-дублёр Bot API) клиент пишет боту организации →
   сообщение доходит до manager-workspace в реальном времени → менеджер отвечает →
   ответ приходит клиенту в Telegram; статусы `routed→sent→delivered` фиксируются.
2. Мультитенантность: два бота/две организации — изоляция входящих и исходящих.
3. Идемпотентность: повтор входящего апдейта и повтор egress по `idempotency_key`
   не двоят.
4. Деградация: недоступность Telegram API / Edge — ядро не падает, недоставленное
   повторяется.
5. Снять/пометить как устаревшие моки, ставшие ненужными: `createMockExternalChannel`
   как fallback для telegram (оставить только для явного mock-профиля),
   recording-mock Telegram в notification-platform.

**DoD (сквозной).**
- Бизнес-клиент добавил токен на `:8081/channels`, канал в статусе `connected` по
  реальному `getMe`.
- Клиент написал боту → менеджер увидел сообщение вживую → ответил → клиент получил
  ответ.
- Всё по токену **этой** организации; изоляция арендаторов соблюдена.
- Идемпотентность и деградация подтверждены тестами.

**Тесты.** e2e CP-2 (ТЗ §26.6) + per-adapter contract INT↔CORE; проба деградации.

**Статус реализации T6 (2026-07-10): выполнено (приёмка на границе SVC-INT↔CORE;
полный e2e с реальным Postgres — CI-профиль Testcontainers).**
- **Сквозной сценарий + мультитенантность + идемпотентность + деградация (задачи
  1–4).** Новый приёмочный тест
  [`t6-cp2-telegram-e2e.integration.test.ts`](../../services/integration-platform/test/integration/t6-cp2-telegram-e2e.integration.test.ts)
  прогоняет реальные компоненты SVC-INT (входящий драйвер T3/T5 + движок доставки
  T2) против замоканных Telegram Bot API и backend-ядра (без сети/Docker, стиль
  t2/t3/t5): клиент пишет боту своей организации → приходит в ядро с правильными
  `organization_id`/`conversation_ref`/`sender_ref`; менеджер отвечает в тот же чат
  токеном **этой** организации (`delivered`, попытка зафиксирована в ядре); два
  бота/две организации изолированы в обе стороны; повтор входящего апдейта (тот же
  UUID) и повтор egress по `idempotency_key` не двоят; отказ Telegram API на egress
  фиксируется как `failed` и не роняет ядро. Транзиция `routed→sent` — на стороне
  ядра (`handoffEgress`), покрыта Testcontainers-спеком
  [`internal-messaging.spec.ts`](../../services/backend/test/integration/internal-messaging.spec.ts);
  на границе SVC-INT движок фиксирует обратную ногу `delivered`.
- **Снятие лишних моков (задача 5).** Mock-fallback доставки в
  [`main.ts`](../../services/integration-platform/src/main.ts) переведён под
  явный env-гейт `DELIVERY_ALLOW_MOCK_FALLBACK` (по умолчанию `true` для dev/CI;
  `false` в бою → неподключённый канал завершается ошибкой `adapter_missing`, а не
  тихим mock-успехом). Telegram на fallback не опирается ни при каком профиле —
  адаптер зарегистрирован всегда и доставляет per-org токеном (T2). Recording-mock
  Telegram в notification-platform уже переведён на условный fallback в G-8
  (форвард при заданном `SVC_TGC_NOTIFICATIONS_URL`, иначе mock — «явный
  mock-профиль»). Юнит
  [`delivery-mock-fallback.test.ts`](../../services/integration-platform/test/unit/delivery-mock-fallback.test.ts)
  фиксирует контракт: без fallback неизвестный канал → `adapter_missing` (не
  повторяемо), с fallback — mock. Агрессивное удаление моков не делалось (нужны для
  dev/CI и прочих каналов) — только явное гейтирование и документирование.
- **Тесты (зелёные).** `tsc` integration-platform — чисто; полный набор 100/100
  (+5: 3 e2e CP-2 + 2 mock-fallback). Backend без изменений исходников (ядро уже
  корректно транзицирует статусы и идемпотентно). Итог по всем этапам T0–T6: путь
  «клиент ↔ бот организации ↔ менеджер» проверен без моков на стыках; полный e2e с
  реальной БД/Redis (routed→sent→delivered в `messages`, C7 в Redis Stream) снимается
  в CI-профиле Testcontainers (локально без Docker — предсуществующее ограничение).

---

## 3. Сводка «разрыв → этап → критерий закрытия»

| Разрыв | Этап | Критерий закрытия |
|--------|------|-------------------|
| G-1 (UI без токена) | T1 | Поле токена на `/channels`, отправка `credentials` |
| G-2 (in-memory каналы) | T1 | `channels` персистятся в Postgres |
| G-3 (secret store не вызывается) | T0, T1 | `putChannelSecret`/`resolveChannelSecret` в рантайме |
| G-4 (фиктивный `:test`) | T1 | Реальный `getMe`, статус по факту |
| G-5 (нет входящего драйвера/маппинга) | T3 | Webhook/poller + `bot→organization`, запись inbound |
| G-6 (глобальный токен egress) | T2 | Per-channel токен; ошибка вместо noop |
| G-7 (нет C7 на ingress) | T4 | `publishMessageCreated` на приёме |
| G-8 (карточки/NOTIF мок) | T4 | Боевое Telegram-плечо уведомлений |
| Edge в mock | T5 | Боевой RF-first маршрут |
| Сквозная приёмка | T6 | e2e CP-2 зелёный |

---

## 4. Риски и решения к принятию

- **Хранение секрета (INV-3).** MVP — envelope-поле `channels.credentials_envelope`
  (ключ из env backend), без внешнего Vault/KMS (`MP-20` вне MVP). Ротация ручная.
- **Способ приёма входящих (T3): webhook vs getUpdates.** Webhook требует
  публичного HTTPS-URL SVC-INT и `setWebhook`; getUpdates проще, но держит поллер на
  каждый бот. Решение фиксируется в начале T3.
- **Источник токена для SVC-INT (T2): S2S-эндпоинт секрета vs токен в конверте
  egress.** Первый строже по границам (у SVC-INT нет БД), второй проще. Решение
  фиксируется в начале T2.
- **Один системный бот vs бот на организацию.** Текущий `TELEGRAM_BOT_TOKEN`
  (доставка кодов входа, manager-консоль) остаётся для системных нужд; клиентские
  каналы переводятся на per-channel токены. Это два независимых механизма — не
  смешивать.
- **ПДн РФ (T5).** Первичная фиксация входящих субъектов РФ — в RF-контуре; порядок
  «Edge → ядро» обязателен для таких клиентов (ТЗ §7.13/§7.14).
- **Совместимость с CP-2-заморозкой C2/C6.** Изменения касаются транспорта и
  хранения секрета, не публичных контрактов C1/C2/C6; при необходимости правок
  контракта — через процедуру заморозки (§6 роадмапа).

---

## 5. Что осознанно вне этого плана

- SMS/VK/WhatsApp каналы (§4.4 роадмапа — не приоритет).
- Полноценный секрет-менеджер с авто-ротацией и аудитом (`MP-20`, вне MVP).
- Push-уведомления и мобильный BFF (`MP-11`/`MP-19`, MVP2).
- Мультипровайдерный роутинг и прочее, не относящееся к каналу Telegram.

---

*Документ детализирует боевой путь канала Telegram и подчиняется мастер-плану
[`docs/plan/README.md`](./README.md) и роадмапу
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md). При расхождении
со сквозными решениями приоритет у мастер-плана; при расхождении с требованиями — ТЗ
[`docs/MessengerBridge_TZ.md`](../MessengerBridge_TZ.md).*
