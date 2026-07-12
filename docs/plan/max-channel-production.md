---
title: План доведения канала MAX до боевого режима
service: Integration Platform / Backend / Edge Gateway / SaaS Administration
service_id: SVC-INT · SVC-API · SVC-EDGE · SVC-ADMIN
version: 1.0
status: Implemented (M0–M6, 2026-07-12)
language: ru-RU
based_on: docs/plan/telegram-channel-production.md, docs/plan/email-channel-production.md, docs/plan/mock-to-production-roadmap.md, docs/plan/services/05-integration-platform.md
date: 2026-07-12
---

# План доведения канала MAX до боевого режима

Документ детализирует конкретные шаги, чтобы **сквозной боевой сценарий MAX**
(мессенджер «Макс») работал без моков и разрывов, по образцу уже проработанного
канала Telegram ([`telegram-channel-production.md`](./telegram-channel-production.md)):

- бизнес-клиент добавляет **токен бота MAX своей организации** на странице
  `:8081/channels` (SaaS Administration);
- бот организации **принимает и обрабатывает входящие** сообщения клиентов;
- менеджер принимает сообщения и **отвечает клиенту**;
- на всех этапах работает доставка **«клиент ↔ edge ↔ app ↔ manager»** и обратно;
- **бот MAX работает на Edge Gateway** (RF-first приземление ПДн субъектов РФ,
  152-ФЗ) — по образцу edge-owned канала Email.

Терминология и нумерация задач наследуются от
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md): `MP-06`
(реальные каналы; §4.4 включает MAX в приоритетную четвёрку Telegram/Email/MAX/Web
Chat), `DR-03` (envelope-секреты), `DR-04` (консолидация egress). Разрывы канала
MAX нумеруются `MG-1…MG-11` (MAX Gap) по аналогии с `G-1…G-8` telegram-плана.

> **Ограничение документа.** Только план. Кода и диффов нет. Оценки трудозатрат в
> человеко-днях/датах — не приводятся; шаги — логические/зависимостные единицы.

---

## 0. Текущее состояние (базовая линия)

Что **уже реально** и переиспользуется, не переписывается:

- Тип канала `max` в каноническом контракте C1 —
  [`message-model/index.ts`](../../packages/contracts/message-model/index.ts)
  (`MESSAGE_CHANNEL.MAX`), и в валидации `channel_type` DTO —
  [`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts)
  (`CHANNEL_TYPES`).
- Capability-профиль C6 для MAX —
  [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
  (`CHANNEL_CAPABILITY_PROFILES.max`).
- Нормализация входящего/исходящего MAX —
  [`max-adapter.ts`](../../services/integration-platform/src/adapters/max/max-adapter.ts)
  (`normalizeIncomingPayload`, `createExternalPayload`, `buildIngress` из общей
  базы [`m2-channel-adapter.ts`](../../services/integration-platform/src/adapters/common/m2-channel-adapter.ts)).
- Схема БД под каналы и per-tenant секрет —
  [`m2_schema.sql`](../../db/migrations/20260703124000000_m2_schema.sql) (`channels`),
  [`stage1_foundation.sql`](../../db/migrations/20260705233000000_stage1_foundation.sql)
  (`channels.credentials_envelope`).
- Envelope-шифрование секрета канала и DI-обёртка —
  [`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts),
  [`channel-secret.service.ts`](../../services/backend/src/common/secrets/channel-secret.service.ts)
  (`ChannelSecretService`, формат `secret://<channel_type>/<org>/<label>`).
- Внутренние S2S-эндпоинты реестра/секрета каналов (кросс-тенантные) —
  [`internal-channels.controller.ts`](../../services/backend/src/modules/integration-gateway/internal-channels.controller.ts)
  (`GET /internal/channels?channel_type=max`, `GET /internal/channels/secret`),
  facade `listActiveChannelsByType` / `resolveChannelDeliveryToken`.
- Приём и запись входящего на стороне ядра —
  [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)
  (`acceptIngress`): Postgres, RLS `withTenant`, идемпотентность,
  `clients`/`communication_endpoints`/`conversations`/`messages`, машина статусов,
  а также публикация C7 `message.created` на приёме (канал-агностична — работает и
  для MAX без доработок, закрытый ранее пробел G-7).
- Исходящий хендофф `handoffEgress` → `forwardEgressDelivery` (канал-агностичен).
- Движок доставки SVC-INT: rate-limit, ретраи с бэкоффом, resilience,
  идемпотентность —
  [`delivery-engine.ts`](../../services/integration-platform/src/delivery/delivery-engine.ts)
  и соседние (`rate-limiter.ts`, `backoff.ts`, `resilience.ts`).
- RF-контур Edge: RF-first буфер, VPN-туннель, приём/туннель-маршруты —
  [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts),
  [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts),
  [`server.ts`](../../services/edge-gateway/src/server.ts).
- **Edge-owned образец — канал Email:**
  [`edge-email-inbound-driver.ts`](../../services/edge-gateway/src/edge-email-inbound-driver.ts),
  [`edge-email-ingress.ts`](../../services/edge-gateway/src/edge-email-ingress.ts),
  [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts),
  [`edge-imap-mailbox.ts`](../../services/edge-gateway/src/edge-imap-mailbox.ts),
  control-plane креды [`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts).
  На нём строится edge-реализация MAX (этапы M4–M5).
- Manager-workspace канал-агностичен (рендерит по каноническому полю `channel`) —
  доработок для MAX не требует.
- UI `:8081/channels` уже содержит коннектор MAX (label/heading) —
  [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx).

Что **разорвано/замокано** и адресуется этим планом (`MG-1…MG-11`):

| ID | Разрыв | Где | Этап |
|----|--------|-----|------|
| **MG-1** | UI-коннектор MAX принимает только `credentials_ref`, не токен бота; нет валидации формата | [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx) (`secretKind:"ref"` для max) | M1 |
| **MG-2** | `:test` для MAX фиктивен — безусловный `connected` без реальной проверки | [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts) (`testChannel`, ветка без upstream) | M1 |
| **MG-3** | Нет реального клиента MAX Bot API — обобщённый HTTP-passthrough | [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts) (`createMaxHttpGatewayClient` → `createGenericHttpChannelClient`) | M2 |
| **MG-4** | Токен MAX глобальный из env, не per-organization | [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts) (`MAX_DELIVERY_URL`/`MAX_ACCESS_TOKEN`), [`main.ts`](../../services/integration-platform/src/main.ts) | M2 |
| **MG-5** | MAX диспетчеризуется только при заданном `MAX_DELIVERY_URL`, иначе mock/`adapter_missing` | [`main.ts`](../../services/integration-platform/src/main.ts) | M2 |
| **MG-6** | Входящий драйвер MAX отсутствует полностью (нет updates-client / inbound-driver / webhook) | [`src/inbound/`](../../services/integration-platform/src/inbound) (только telegram-*) | M3 |
| **MG-7** | Нет активации маппинга «бот MAX → организация» (реестр есть, поллинга нет) | integration-platform | M3 |
| **MG-8** | На Edge Gateway для MAX нет ничего; требование «бот max на edge» не выполнено | [`services/edge-gateway/src`](../../services/edge-gateway/src) | M4 |
| **MG-9** | Нет RF-first маршрута для MAX (буфер → туннель), нет приземления ПДн РФ | edge-cluster / integration | M5 |
| **MG-11** | Не зафиксирована схема/состав кред MAX и валидация формата | secret store + DTO | M0 |

> **MG-10 (не разрыв).** C7 realtime на ingress и egress-триггер `handoffEgress`
> канал-агностичны и уже закрыты (T4) — менеджер увидит входящее MAX вживую и
> ответит без доработок ядра. Отмечено для полноты.
>
> **Зависимость-контекст.** Edge-owned образец (Email) сам ещё не подключён к
> рантайму: `createEdgeEmailInboundDriver`/`createEdgeEmailSender` определены и
> покрыты тестами, но **не вызываются** из
> [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts). Подключение
> edge-драйверов к рантайму (общий пробел email/MAX) закрывается в этапе M5.

---

## 1. Ключевое архитектурное решение

Требование «**на edge работает бот max**» + MAX — российский мессенджер (152-ФЗ,
первичная фиксация ПДн субъектов РФ в RF-контуре, ТЗ §7.13/§7.14) ⇒ MAX делается
**Edge-owned, по образцу Email**, а не app-side (как Telegram).

- **Вариант B (принят): MAX — Edge-owned.** Бот MAX (приём и отправка) работает
  на Edge Gateway. App-side `max-adapter` остаётся источником нормализации/C6
  capability (как email-адаптер: «для C6, но SVC-INT его не диспетчеризует»).
- Вариант A (app-side, как Telegram) — меньше нового кода, но не удовлетворяет
  требованию «бот на edge» и слабее по 152-ФЗ. Остаётся запасным (и служит
  промежуточной ступенью: этапы M1–M3 сначала поднимают MAX app-side, M4–M5
  переносят его на Edge).

```
ВХОДЯЩЕЕ (клиент → менеджер):
  Клиент в MAX
    → MAX Bot API (getUpdates ИЛИ webhook по токену организации)
    → Edge: max inbound driver           [M4]
        · резолв токена → organization_id + channel_id  [M3/M4]
        · нормализация → C2.IngressMessage             [M3]
    → RF-first буфер (edge-cluster.ingest)             [M5]
    → VPN-туннель → Backend /internal/edge/tunnel/messages
        · acceptIngress: persist inbound               [есть]
        · publishMessageCreated → C7 Redis Stream      [есть, MG-10]
    → Edge C7 WS → manager-workspace (live)            [есть]

ИСХОДЯЩЕЕ (менеджер → клиент):
  manager-workspace
    → Backend POST /messages (outbound)                [есть]
    → handoffEgress → forwardEgressDelivery            [есть]
    → (для edge-организаций) туннель → Edge: max sender [M4]
        · резолв токена организации                    [M2]
        · MAX Bot API sendMessage                      [M2]
    → MAX → Клиент
    → recordDeliveryAttempt (статусы routed→sent→delivered) [есть]
```

Ключевая мысль (как в Telegram): **токен организации — единица маршрутизации в обе
стороны**. Входящее приходит на бот с этим токеном → определяем организацию;
исходящее доставляется этим же токеном.

---

## 2. Этапы и последовательность

Граф зависимостей (ребро = «нужно раньше»):

```
Этап M0 (секрет + формат кред MAX) ─┬─→ Этап M1 (регистрация + токен + реальный :test, MG-1,2,11)
                                    └─→ Этап M2 (реальный MAX Bot API egress, per-org, MG-3,4,5)
Этап M1 ─→ Этап M3 (входящий драйвер + маппинг бот→организация, MG-6,7)
Этап M2, M3 ─→ Этап M4 (перенос бота MAX на Edge, MG-8)
Этап M4 ─→ Этап M5 (RF-first, деградация, wiring в edge-runtime, MG-9)
Все ──────→ Этап M6 (сквозная приёмка «MAX: приём и ответ», снятие моков)
```

Параллелизуемость: **M1 и M2** независимы после M0; edge-инфраструктура M4–M5
(сетевой контур) может вестись параллельно с M1–M3, синхронизируя точку стыка в M6.

---

### Этап M0 — Фундамент секрета канала MAX (DR-03, MG-11)

**Цель.** Зафиксировать формат и состав кред MAX; подключить существующий
`ChannelSecretStore` для типа `max`.

**Задачи.**
1. Зафиксировать формат ссылки `secret://max/<organization_id>/<label>` (хелпер
   `buildCredentialsRef` уже поддерживает произвольный `channel_type`).
2. Определить состав секрета MAX: токен бота (обязателен); при варианте webhook —
   дополнительно webhook-secret для верификации входящих. Решение фиксируется в
   начале M0.
3. Добавить в [`.env.example`](../../.env.example) `MAX_API_BASE_URL` (боевой хост
   MAX Bot API) и комментарий про формат `credentials_ref`; при edge-варианте —
   зеркально в [`.env.rf.example`](../../.env.rf.example) (см. M4).

**Затрагиваемые файлы.**
[`channel-secret.service.ts`](../../services/backend/src/common/secrets/channel-secret.service.ts)
(без изменений логики), [`.env.example`](../../.env.example) (комментарий/переменные).

**DoD.** Секрет MAX пишется/читается через `channels.credentials_envelope` под RLS
тем же механизмом, что Telegram; формат ссылки и состав секрета задокументированы.

**Тесты.** unit (encrypt/decrypt round-trip для `max`), integration
(put→resolve через Postgres с RLS) — переиспользуют существующие спеки секрет-стора.

**Статус реализации M0 (2026-07-12): выполнено.**
- **Решение по составу секрета MAX (задача 2).** Секрет MAX (MVP) — **только токен
  бота** (одна plaintext-строка в `channels.credentials_envelope`, как Telegram;
  вариант приёма getUpdates long-poll, Этап M3). Webhook-secret не вводится, пока не
  выбран webhook-вариант (решение отложено в M3). Механизм секрет-стора
  канал-агностичен — новой логики шифрования не потребовалось.
- **Формат ссылки (задача 1).** Зафиксирован `secret://max/<organization_id>/<label>`;
  `buildCredentialsRef` уже поддерживает произвольный `channel_type`. Обновлён
  docstring
  [`channel-secret.service.ts`](../../services/backend/src/common/secrets/channel-secret.service.ts)
  (пример MAX + пометка о составе секрета) — без изменений логики.
- **Конфигурация (задача 3).** В [`.env.example`](../../.env.example) добавлена
  переменная `MAX_API_BASE_URL` (боевой хост MAX Bot API; пусто — клиент не
  сконфигурирован, точный хост уточняется по спецификации MAX Bot API в M1/M2) и
  блок-комментарий целевой модели (per-org токен в `credentials_envelope`);
  прежние `MAX_DELIVERY_URL`/`MAX_ACCESS_TOKEN`/`MAX_BOT_TOKEN` помечены DEPRECATED
  (снимаются в M2/M4). Комментарий про `CHANNEL_SECRET_ENCRYPTION_KEY` обобщён на
  каналы Telegram + MAX. Зеркалирование в `.env.rf.example` отложено к M4 (edge).
- **Тесты (зелёные).** unit
  [`channel-secret.store.spec.ts`](../../services/backend/test/unit/channel-secret.store.spec.ts)
  (round-trip токена MAX без утечки plaintext; резолв по `secret://max/...`) и
  integration-стаб
  [`channel-secret.service.spec.ts`](../../services/backend/test/integration/channel-secret.service.spec.ts)
  (`buildCredentialsRef` для `max`; put→resolve секрета MAX через RLS-контекст
  platform operator). Прогон обоих спеков — 8/8 passed; `tsc --noEmit` backend —
  чисто. Реальный Postgres-прогон RLS выполняется в CI-профиле `test:integration`
  (Testcontainers), как и для Telegram T0.

---

### Этап M1 — Регистрация канала и приём токена (MG-1, MG-2, MG-11)

**Цель.** Бизнес-клиент вводит токен бота MAX на `:8081/channels`; токен шифруется
и сохраняется; тест канала реально проверяет токен через MAX Bot API.

**Задачи (frontend, SVC-ADMIN).**
1. В [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx)
   для коннектора `max` перевести `secretKind` с `"ref"` на `"token"`: масковое
   поле «Токен бота MAX», клиентская валидация формата токена MAX.
2. Обновить типы/клиент API и MSW-моки
   ([`handlers.ts`](../../apps/saas-admin/src/api/mocks/handlers.ts)): `createChannel`
   для MAX шлёт `{organization_id, channel_type:"max", name, credentials:<token>,
   config:{}}`; мок принимает токен, возвращает только `credentials_ref`, `:test`
   → детерминированный `connected`.

**Задачи (backend, SVC-API).**
3. Валидация: для `max` токен обязателен, формат — по спецификации MAX Bot API
   (зафиксировать regex в DTO
   [`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts)).
   Секрет шифруется в `credentials_envelope`, в ответе **никогда** не возвращается
   (механизм `connectChannel`/`resolveSecretPlaintext` уже это делает для любого типа).
4. Реальный `:test`: добавить `testMaxChannel` в
   [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
   по аналогии с `testTelegramChannel` — резолвить токен и вызвать «who am I»/
   `getMe`-аналог MAX Bot API; `ok` → `status=connected` + сохранить в `config`
   идентификаторы бота, иначе `status=error` + причина. Обернуть в `FacadeResilience`.
   Диспетчеризовать `channel_type==="max"` на `testMaxChannel` в `testChannel`.

**DoD.** POST `/api/v1/channels` с токеном MAX → строка в `channels` +
`credentials_envelope` заполнен; токен нигде не возвращается/не логируется;
`POST /channels/{id}:test` для валидного токена возвращает `connected` по реальному
вызову MAX Bot API; UI позволяет ввести токен и показывает статус/ошибку. Изоляция
арендатора (RLS) сохранена.

**Тесты.** unit (валидация токена MAX, маппинг DTO), integration (Backend↔Postgres:
connect→secret stored→test через **мок MAX API**), UI-тест формы.

**Статус реализации M1 (2026-07-12): выполнено.**
- **Решение по проверке (MG-2).** `:test` для MAX вызывает `GET
  {MAX_API_BASE_URL}/me?access_token=<token>` MAX Bot API (контракт наследует
  TamTam Bot API; хост по умолчанию `https://botapi.max.ru`, переопределяется env —
  **допущение, подтверждается по официальной спецификации MAX Bot API**). Формат
  токена — непрозрачная строка; валидация формата — клиентская (как у Telegram),
  сервер полагается на реальный `:test`.
- **Backend.** В
  [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
  добавлены `testMaxChannel` + `runMaxGetMe` (симметрично `testTelegramChannel`/
  `runTelegramGetMe`, в обёртке `FacadeResilience`), диспетчеризация
  `channel_type==="max"` в `testChannel`, опция/поле `maxApiBaseUrl`
  (env `MAX_API_BASE_URL`, дефолт `botapi.max.ru`). Успех → `connected` +
  `config.bot_id`/`bot_username`; нет токена/`/me` отклонён → `error` с причиной.
  Сохранение токена в `credentials_envelope` и невозврат секрета уже обеспечивает
  канал-агностичный `connectChannel` (M0). DTO не менялся (Telegram тоже без
  серверного regex).
- **Frontend.** В
  [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx)
  коннектор MAX переведён с `secretKind:"ref"` на `"token"` (масковое поле «Токен
  бота», конфиг `bot_username`); валидация токена стала per-connector
  (`tokenPattern`/`tokenHint`): Telegram — прежний формат, MAX —
  `^[A-Za-z0-9_.-]{20,}$`. MSW-моки и клиент API уже принимали `credentials`
  канал-агностично — правок не потребовалось.
- **Тесты (зелёные).** backend unit
  [`integration-gateway.facade.spec.ts`](../../services/backend/test/unit/integration-gateway.facade.spec.ts)
  (шифрование токена MAX; `:test` `/me` ok/401/без токена) и integration-стаб
  [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts)
  (MAX вынесен из общего параметризованного списка в отдельный сценарий: connect с
  токеном → `/me` → `connected` + `bot_username`/`bot_id`; ref без envelope →
  `error`); frontend
  [`m2-channels-knowledge.test.tsx`](../../apps/saas-admin/test/m2-channels-knowledge.test.tsx)
  (MAX подключается токеном, `credentials` в запросе, `credentials_ref` не
  передаётся). Прогоны: backend facade+channels **25/25**, весь saas-admin
  **100/100**; `tsc --noEmit` backend и saas-admin — чисто. Реальный Postgres/RLS —
  в CI-профиле Testcontainers.

---

### Этап M2 — Исходящая доставка реальным MAX Bot API по токену организации (MG-3, MG-4, MG-5)

**Цель.** Egress в MAX использует **реальный MAX Bot API** и **per-channel** токен
из secret store, а не обобщённый HTTP-passthrough с глобальным env-токеном.

**Задачи.**
1. Заменить `createMaxHttpGatewayClient` (обобщённый passthrough) на **реальный**
   `createMaxBotApiClient` в
   [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts):
   вызовы боевых методов MAX Bot API (текст, вложения), корректный разбор ответа и
   `external_message_id` провайдера, маппинг методов (аналог `toTelegramRequestBody`).
2. Добавить `createResolvingMaxClient` (аналог `createResolvingTelegramClient`):
   резолв токена по `organization_id` доставки через существующий
   [`backend-channel-secret-client.ts`](../../services/integration-platform/src/delivery/backend-channel-secret-client.ts)
   (`GET /internal/channels/secret` уже принимает `channel_type=max`); клиент
   кэшируется по токену. Нет токена → **НЕповторяемая ошибка** (`failed`,
   `missing_channel_secret`), а не «тихий noop»/mock.
3. В [`main.ts`](../../services/integration-platform/src/main.ts) регистрировать MAX
   в диспетчере доставки **всегда** (как Telegram), убрав опору на `MAX_DELIVERY_URL`
   как источник токена; сохранить rate-limit MAX (уже задан) и resilience.
4. `createExternalPayload` в
   [`max-adapter.ts`](../../services/integration-platform/src/adapters/max/max-adapter.ts)
   привести к форме, которую ожидает реальный MAX Bot API (методы/поля вложений).

**DoD.** Ответ менеджера в организации A уходит через токен A, в организации B — через
токен B; при отсутствии/невалидности токена доставка фиксируется как `failed` с
причиной (не молчаливый успех); повтор с тем же `idempotency_key` не создаёт дубль;
возвращается настоящий `external_message_id`.

**Тесты.** unit (резолвер токена MAX, ошибка при отсутствии токена, маппинг
payload), integration (две организации, два токена, доставка через **мок MAX API**;
повтор без дубля; missing token → `failed`).

**Статус реализации M2 (2026-07-12): выполнено.**
- **Реальный MAX Bot API (MG-3).** В
  [`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts)
  обобщённый `createMaxHttpGatewayClient` заменён на `createMaxBotApiClient`:
  `POST {base}/messages?access_token=<token>&chat_id=<id>` с телом `{ text,
  attachments }` (`toMaxRequestBody`), разбор `external_message_id` из
  `message.body.mid`, `provider:"max"`. Ошибки провайдера — через общий
  `providerError` (читает `message`/retry-after).
- **Per-org токен (MG-4).** Добавлен `createResolvingMaxClient` (симметрично
  `createResolvingTelegramClient`): токен резолвится по `organization_id` через тот
  же backend S2S secret-клиент
  ([`backend-channel-secret-client.ts`](../../services/integration-platform/src/delivery/backend-channel-secret-client.ts),
  `/internal/channels/secret?channel_type=max`), клиент кэшируется по токену; нет
  токена → НЕповторяемая `ChannelDeliveryError(category:"missing_channel_secret")`.
- **Регистрация всегда (MG-5).**
  [`main.ts`](../../services/integration-platform/src/main.ts): MAX-адаптер получает
  `maxDeliveryClient` (per-org) и **всегда** регистрируется в диспетчере доставки
  (снята опора на `MAX_DELIVERY_URL`); `createRealChannelClientsFromEnv` больше не
  собирает MAX (глобальный env-шлюз убран). Rate-limit MAX (25/s) и resilience
  сохранены. `createExternalPayload` MAX уже отдаёт нативную форму (`chat_id`/
  `text`/`attachments`) — правок не потребовалось (задача 4).
- **Тесты (зелёные).** unit
  [`real-channel-clients.test.ts`](../../services/integration-platform/test/unit/real-channel-clients.test.ts)
  (MAX Bot API: `/messages` + query `chat_id`, `mid` → `external_message_id`) и
  [`channel-token-resolution.test.ts`](../../services/integration-platform/test/unit/channel-token-resolution.test.ts)
  (per-org доставка MAX; нет токена → non-retryable `missing_channel_secret`);
  integration
  [`m2-per-org-max-delivery.integration.test.ts`](../../services/integration-platform/test/integration/m2-per-org-max-delivery.integration.test.ts)
  (org A→max-A, org B→max-B; повтор `idempotency_key` без дубля; org без токена →
  `failed`, не «тихий noop»). Прогоны: SVC-INT unit **76/76**, integration
  **29/29**, contract **6/6**; `tsc -p` — чисто.

---

### Этап M3 — Входящий драйвер и маппинг «бот MAX → организация» (MG-6, MG-7)

**Цель.** Реально получать входящие клиентов на бот организации и доводить их до
`acceptIngress` с корректными `organization_id`/`channel_id`. (На этом этапе драйвер
поднимается app-side по образцу Telegram; перенос на Edge — M4.)

**Задачи.**
1. Выбрать способ приёма (зафиксировать решением в начале M3): **getUpdates
   long-poll** (проще, без публичного URL — рекомендуется как первая ступень) или
   **webhook** (для прод; требует публичного HTTPS-URL и верификации webhook-secret
   из M0).
2. Реализовать `max-updates-client` (клиент MAX Bot API `getUpdates`/приём webhook)
   и `max-inbound-driver` в
   [`src/inbound/`](../../services/integration-platform/src/inbound) по образцу
   [`telegram-inbound-driver.ts`](../../services/integration-platform/src/inbound/telegram-inbound-driver.ts):
   реестр каналов из `GET /internal/channels?channel_type=max`
   ([`backend-channels-client.ts`](../../services/integration-platform/src/inbound/backend-channels-client.ts)
   переиспользуется), резолв токена (M2), нормализация через
   `adapters.max.buildIngress`, публикация через
   [`ingress-publisher.ts`](../../services/integration-platform/src/inbound/ingress-publisher.ts).
3. Дедуп/идемпотентность: детерминированный **UUID** из `channel_id + update_id`
   (использовать паттерн [`ids.ts`](../../services/integration-platform/src/inbound/ids.ts);
   учесть урок T5 — `message.id` ядро принимает только как UUID). Читаемый MAX-id —
   в `external_message_id`. Оффсеты per-channel.
4. Маппинг отправителя: `chat_id`/`dialog_id` → `conversation_ref`,
   `sender.user_id` → `sender_ref` (уже реализовано в `normalizeIncomingPayload`
   MAX-адаптера — драйвер прокидывает сырой апдейт).
5. Wiring в [`main.ts`](../../services/integration-platform/src/main.ts): поднимать
   драйвер после `listen` под гейтом `MAX_INBOUND_ENABLED`, останавливать по
   SIGINT/SIGTERM.

**DoD.** Сообщение реального клиента боту организации доходит до `messages` как
`inbound/client/routed` с правильным `organization_id`; повтор апдейта не двоит;
несколько организаций/ботов изолированы; менеджер видит входящее вживую (C7, MG-10).

**Тесты.** unit (резолв `channel_id → organization_id`, дедуп `update_id`, изоляция
оффсетов, пропуск неингестируемого апдейта, пропуск канала без токена), integration
(мок MAX API шлёт апдейт → SVC-INT → backend ingress → строка в `messages`), негатив
(неизвестный `channel_id`).

**Статус реализации M3 (2026-07-12): выполнено. Решение по §1 — getUpdates
long-poll (marker-курсор), app-side.**
- **Способ приёма.** Выбран getUpdates long-poll: не требует публичного HTTPS-URL,
  легко тестируется моком. Отличие от Telegram — курсор **marker** (батч-уровень из
  ответа `getUpdates`), а не offset per-update; webhook остаётся альтернативой.
- **Клиент/драйвер.** Новые
  [`max-updates-client.ts`](../../services/integration-platform/src/inbound/max-updates-client.ts)
  (`GET {base}/updates?access_token&marker&timeout` → `{updates, marker}`) и
  [`max-inbound-driver.ts`](../../services/integration-platform/src/inbound/max-inbound-driver.ts)
  (реестр из `GET /internal/channels?channel_type=max`, резолв токена M2,
  нормализация через `adapters.max.buildIngress`, публикация через переиспользуемый
  `ingress-publisher` напрямую в ядро — edge для MAX в M4). Дедуп/идемпотентность —
  `stableMaxMessageId(channelId, mid)` в
  [`ids.ts`](../../services/integration-platform/src/inbound/ids.ts) (детерминированный
  UUID из `message.body.mid`; при retryable-сбое marker не двигается, батч
  переопрашивается, дубли снимает `acceptIngress`).
- **Нормализация (MG-7).** `max-adapter.normalizeIncomingPayload`
  ([`max-adapter.ts`](../../services/integration-platform/src/adapters/max/max-adapter.ts))
  расширена под реальную вложенную форму MAX Bot API: `recipient.chat_id` →
  `conversation_ref`, `sender.user_id` → `sender_ref`, `body.mid` →
  `external_message_id`, `body.text` → текст, `message.timestamp` (epoch ms) →
  `occurred_at`; плоская форма сохранена (обратная совместимость).
- **Wiring.** [`main.ts`](../../services/integration-platform/src/main.ts) поднимает
  драйвер после `listen` под гейтом `MAX_INBOUND_ENABLED` (по умолчанию включён),
  останавливает по SIGINT/SIGTERM. Env — в [`.env.example`](../../.env.example)
  (`MAX_INBOUND_ENABLED`, `MAX_INBOUND_POLL_TIMEOUT_SECONDS`,
  `MAX_INBOUND_REFRESH_INTERVAL_MS`).
- **Тесты (зелёные).** unit
  [`max-inbound-driver.test.ts`](../../services/integration-platform/test/unit/max-inbound-driver.test.ts)
  (маппинг бот→организация, дедуп/продвижение marker, изоляция per-channel,
  пропуск неингестируемого/без токена, снятие отключённого канала); integration
  [`m3-max-inbound.integration.test.ts`](../../services/integration-platform/test/integration/m3-max-inbound.integration.test.ts)
  (мок MAX API → SVC-INT → ядро: `inbound/max` с правильными
  `organization_id`/`conversation_ref`/`sender_ref`; повтор сообщения не двоит; две
  организации изолированы). Прогоны: SVC-INT unit **82/82**, integration **31/31**;
  `tsc -p` — чисто. Менеджер видит входящее вживую переиспользуемым C7 на ingress
  (MG-10) — доработок не требует.

---

### Этап M4 — Перенос бота MAX на Edge Gateway (MG-8) ← ядро требования

**Цель.** Бот MAX (приём **и** отправка) работает на Edge Gateway, по образцу
edge-owned канала Email. Требование «на edge работает бот max» выполнено.

**Задачи.**
1. Входящий на edge: `edge-max-inbound-driver` (аналог
   [`edge-email-inbound-driver.ts`](../../services/edge-gateway/src/edge-email-inbound-driver.ts))
   + `edge-max-ingress` (нормализация в C2.IngressMessage, аналог
   [`edge-email-ingress.ts`](../../services/edge-gateway/src/edge-email-ingress.ts),
   переиспользуя логику `max-adapter`) + инъектируемый `max-updates-client` (боевая
   реализация приёма — long-poll/webhook, из M3).
2. Исходящий на edge: `edge-max-sender` (реализует `EdgeEmailSender`-подобный сеам
   из control-plane, аналог
   [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts)):
   по `egress_dispatch` резолвит токен организации из локального кэша control-plane
   и вызывает MAX Bot API `sendMessage`.
3. Синхронизация кред MAX в edge control-plane
   ([`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts))
   — как email E2: токены per-organization приходят с app-стороны и кэшируются на
   edge; нет кред → канал пропускается.
4. App-side: для edge-организаций отключить app-side диспетчеризацию MAX (как email
   в [`main.ts`](../../services/integration-platform/src/main.ts): «адаптер оставлен
   для C6, но SVC-INT его не диспетчеризует»).
5. Конфиг: MAX-переменные (`MAX_API_BASE_URL` и пр.) добавить в
   [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml) и
   [`.env.rf.example`](../../.env.rf.example).

**DoD.** Входящее MAX принимается **на edge**, нормализуется и уходит в ядро через
туннель; ответ менеджера доставляется клиенту MAX-отправителем **на edge** токеном
этой организации; app-side MAX-диспетчер для edge-организаций не задействован.

**Тесты.** unit (edge inbound driver/sender с инъектируемым MAX-клиентом: маппинг
бот→организация, дедуп, пропуск канала без кред), integration (edge e2e по образцу
[`email-channel-e2e.test.ts`](../../services/edge-gateway/test/integration/email-channel-e2e.test.ts)).

**Статус реализации M4 (2026-07-12): выполнено (edge-компоненты MAX + control-plane;
подключение к рантайму edge-runtime — Этап M5, как у email).**
- **Входящее на Edge (задача 1).** Новые
  [`edge-max-ingress.ts`](../../services/edge-gateway/src/edge-max-ingress.ts)
  (`buildMaxIngress` → C2.IngressMessage + поля верхнего уровня `id`/`endpoint_id`
  для RF-буфера; порт нормализации MAX-адаптера на Edge),
  [`edge-max-updates-client.ts`](../../services/edge-gateway/src/edge-max-updates-client.ts)
  (боевой getUpdates MAX Bot API, сеам как `edge-imap-mailbox`) и
  [`edge-max-inbound-driver.ts`](../../services/edge-gateway/src/edge-max-inbound-driver.ts)
  (реестр каналов, резолв токена из control-plane, marker-курсор, дедуп по `mid`,
  RF-first `ingest`; при сбое приёма marker не двигается — апдейт не теряется). Ids —
  `stableMaxMessageId`/`stableMaxEndpointId` в
  [`edge-ids.ts`](../../services/edge-gateway/src/edge-ids.ts) (тот же UUID, что
  app-side — идемпотентность при миграции).
- **Исходящее на Edge (задача 2).**
  [`edge-max-sender.ts`](../../services/edge-gateway/src/edge-max-sender.ts):
  `send(delivery)` → токен из `delivery.credentials` → `POST /messages` MAX Bot API
  (chat_id из `recipient_ref`), инъектируемый `fetchImpl`. Реализует сеам
  `EdgeChannelSender` control-plane (аналог `EdgeEmailSender`, E4).
- **Control-plane (задача 3).**
  [`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts)
  стал канал-осведомлённым: креды хранятся по `${org}:${channel_type}` (email и MAX
  одной организации не затирают друг друга), `egress_dispatch` роутится по
  `channel_type` (`maxSender` для max, `emailSender` для email), добавлен
  `getChannelCredentials(org, type)`; `getEmailCredentials`/`hasCredentials` —
  обратно совместимы. Креды MAX приходят с App-стороны через `channel_credentials_sync`
  (payload `{channel_id, channel_type:"max", credentials:{token}}`) и шифруются в
  памяти тем же RF-cipher.
- **Конфиг (задача 5).** MAX-переменные добавлены в
  [`.env.rf.example`](../../.env.rf.example) и edge-gateway сервис
  [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml)
  (`MAX_API_BASE_URL`, `MAX_INBOUND_*`).
- **Осознанно вне M4.** Подключение edge-драйверов MAX (и email) к рантайму
  [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts) и отключение
  app-side диспетчеризации MAX для edge-организаций (задача 4) переносятся в M5 —
  ровно как edge-owned email сейчас: компоненты E2–E6 существуют и покрыты тестами,
  но в рантайм не подключены. App-side путь MAX (M3) остаётся рабочим до M5.
- **Тесты (зелёные).** unit
  [`edge-max-ingress.test.ts`](../../services/edge-gateway/test/unit/edge-max-ingress.test.ts),
  [`edge-max-inbound-driver.test.ts`](../../services/edge-gateway/test/unit/edge-max-inbound-driver.test.ts),
  [`edge-max-sender.test.ts`](../../services/edge-gateway/test/unit/edge-max-sender.test.ts),
  MAX-кейсы в
  [`edge-control-plane.test.ts`](../../services/edge-gateway/test/unit/edge-control-plane.test.ts)
  (разделение кред email/MAX, роутинг egress); integration
  [`max-channel-e2e.test.ts`](../../services/edge-gateway/test/integration/max-channel-e2e.test.ts)
  (токен-sync → приём getUpdates → RF-first → туннель → ответ менеджера → MAX Bot API;
  без потерь при разрыве в обе стороны; идемпотентность по `control_id`). Прогон:
  весь edge-gateway **138/138**; `tsc -p` — чисто.

---

### Этап M5 — RF-first контур и деградация (MG-9)

**Цель.** Маршрутизировать трафик MAX через Edge Cluster согласно «клиент ↔ **edge**
↔ app ↔ manager» (ТЗ §7.13/§7.14) с RF-first приземлением и устойчивостью к обрыву
туннеля.

**Задачи.**
1. Первичное приземление входящих ПДн субъектов РФ — в RF-буфере до форвардинга
   (`edge-cluster.ingest`, RF-first, sequence_number, шифрование — инфраструктура
   уже есть, [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts)).
2. **Подключить edge-драйверы MAX (и заодно Email) к рантайму**
   [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts) в режиме
   `edge` — закрывает общий пробел wiring edge-owned каналов.
3. Деградация: недоступность туннеля → буферизация и авто-дренаж на reconnect; при
   транзиентной ошибке приёма оффсет MAX **не двигается** (апдейт переопрашивается —
   урок T5), ядро не блокируется (ТЗ §11.2).

**DoD.** Для клиента РФ входящее MAX сначала фиксируется в RF-буфере, затем доходит
до ядра; при обрыве туннеля не теряется и досылается; edge не в `mock`.

**Тесты.** integration (RF-first порядок записи, дренаж после reconnect; проба
деградации «туннель недоступен → ядро работает; оффсет не двинут»).

**Статус реализации M5 (2026-07-12): выполнено.**
- **Сборка рантайма (задача 2).** Новый
  [`edge-channel-drivers.ts`](../../services/edge-gateway/src/edge-channel-drivers.ts)
  (`createEdgeChannelRuntime`) собирает воедино M4-компоненты MAX: `EdgeMaxSender`
  (исходящее) → инжектится в `EdgeControlPlane` (кэш кред + реестр каналов + роутинг
  egress) → `EdgeMaxInboundDriver` (входящее getUpdates → RF-first `cluster.ingest`).
- **Реестр каналов на Edge (MG-9).**
  [`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts)
  выводит реестр каналов из `channel_credentials_sync` (`channel_id`→`{org,type,config}`)
  и отдаёт его через `listChannels({channelType})` — Edge поллит только каналы, чьи
  креды к нему синхронизированы с App-стороны (нет прямого доступа к БД, ТЗ §22.3).
- **Control-intake (задача 2).**
  [`server.ts`](../../services/edge-gateway/src/server.ts) получил маршрут
  `POST /internal/edge/control/messages` → `controlPlane.handle` (активен только
  когда рантайм собрал канальные драйверы).
- **Подключение к рантайму (задачи 1–3).**
  [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts) в режиме `edge`
  за гейтом `EDGE_CHANNEL_DRIVERS=on` (по умолчанию **off** — поведение живого edge
  не меняется, пока App-сторона не начнёт синхронизировать креды) поднимает
  `createEdgeChannelRuntime`, прокидывает его `controlPlane` в сервер и стартует
  MAX-драйвер; останавливает в `close`. RF-first буфер, деградация и дренаж —
  готовый `EdgeCluster` (буфер + туннель); при транзиентном сбое приёма marker не
  двигается (урок T5, покрыто в M4). Env — `EDGE_CHANNEL_DRIVERS` в
  [`.env.rf.example`](../../.env.rf.example) и
  [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml).
- **Тесты (зелёные).** integration
  [`edge-channel-drivers.test.ts`](../../services/edge-gateway/test/integration/edge-channel-drivers.test.ts)
  (обнаружение канала из creds-sync → RF-first через туннель; буферизация при обрыве
  и дренаж после reconnect без потерь; ответ менеджера → MAX-sender) и
  [`edge-control-intake.test.ts`](../../services/edge-gateway/test/integration/edge-control-intake.test.ts)
  (control-маршрут → control-plane; 400 при отклонении; отсутствует без
  control-plane); MAX-кейс реестра — в
  [`edge-control-plane.test.ts`](../../services/edge-gateway/test/unit/edge-control-plane.test.ts).
  Прогон: весь edge-gateway **144/144**; `tsc -p` — чисто; гейт off сохраняет
  прежнее поведение рантайма.
- **Осознанно вне M5.** App-сторона (backend/SVC) ещё не синхронизирует креды и не
  шлёт egress_dispatch на Edge — то же ограничение у edge-owned email; появление
  этого App→Edge потока и отключение app-side диспетчеризации MAX (M4 задача 4)
  закрываются вместе с боевым App-интегрированием (M6/деплой). Email подключается в
  эту же сборку по идентичной схеме, как только появится его SMTP-транспорт
  (nodemailer, MP-12).

---

### Этап M6 — Сквозная приёмка «MAX: приём и ответ»

**Цель.** Подтвердить весь путь без моков и разрывов.

**Задачи.**
1. e2e-сценарий: реальный (или тест-дублёр MAX Bot API) клиент пишет боту
   организации → сообщение доходит до manager-workspace в реальном времени →
   менеджер отвечает → ответ приходит клиенту в MAX; статусы `routed→sent→delivered`
   фиксируются.
2. Мультитенантность: два бота/две организации — изоляция входящих и исходящих.
3. Идемпотентность: повтор входящего апдейта и повтор egress по `idempotency_key`
   не двоят.
4. Деградация: недоступность MAX API / Edge — ядро не падает, недоставленное
   повторяется.
5. Снять/пометить как устаревшие моки, ставшие ненужными: обобщённый
   HTTP-passthrough MAX, mock-fallback доставки для MAX (оставить только для явного
   mock-профиля dev/CI).

**DoD (сквозной).**
- Бизнес-клиент добавил токен MAX на `:8081/channels`, канал в статусе `connected`
  по реальной проверке MAX Bot API.
- Клиент написал боту → менеджер увидел сообщение вживую → ответил → клиент получил
  ответ.
- Весь путь идёт через Edge («клиент ↔ edge ↔ app ↔ manager»); всё по токену **этой**
  организации; изоляция арендаторов соблюдена.
- Идемпотентность и деградация подтверждены тестами.

**Тесты.** e2e (аналог
[`t6-cp2-telegram-e2e.integration.test.ts`](../../services/integration-platform/test/integration/t6-cp2-telegram-e2e.integration.test.ts))
+ edge e2e (аналог email) + проба деградации.

**Статус реализации M6 (2026-07-12): выполнено (приёмка на границе SVC-INT↔CORE;
edge-путь — edge e2e M4/M5; полный e2e с реальным Postgres — CI Testcontainers).**
- **Сквозной сценарий + мультитенантность + идемпотентность + деградация (задачи
  1–4).** Новый приёмочный тест
  [`m6-cp-max-e2e.integration.test.ts`](../../services/integration-platform/test/integration/m6-cp-max-e2e.integration.test.ts)
  прогоняет реальные компоненты SVC-INT (входящий драйвер M3 + движок доставки M2)
  против замоканных MAX Bot API и ядра: клиент пишет боту своей организации →
  приходит в ядро с правильными `organization_id`/`conversation_ref`/`sender_ref`;
  менеджер отвечает в тот же чат токеном **этой** организации (`delivered`, попытка
  зафиксирована как `adapter:"max"`); два бота/две организации изолированы в обе
  стороны; повтор входящего (тот же UUID из `mid`) и повтор egress по
  `idempotency_key` не двоят; отказ MAX API на egress → `failed`, ядро не падает.
  Edge-путь (RF-first «клиент ↔ edge ↔ app ↔ manager») подтверждён edge e2e
  [`max-channel-e2e.test.ts`](../../services/edge-gateway/test/integration/max-channel-e2e.test.ts)
  (M4) и
  [`edge-channel-drivers.test.ts`](../../services/edge-gateway/test/integration/edge-channel-drivers.test.ts)
  (M5).
- **Снятие лишних моков (задача 5).** Обобщённый HTTP-passthrough MAX
  (`createMaxHttpGatewayClient`) снят ещё в M2 (заменён реальным
  `createMaxBotApiClient` + per-org `createResolvingMaxClient`). MAX на mock-fallback
  доставки **не опирается ни при каком профиле**: адаптер зарегистрирован всегда и
  доставляет per-org токеном; при отсутствии токена — `failed`
  (`missing_channel_secret`), а не тихий mock-успех. Приёмочный тест фиксирует этот
  контракт отдельным кейсом («no token → failed, sends=0»).
- **Тесты (зелёные).** `tsc -p` SVC-INT — чисто; полный набор SVC-INT unit
  **82/82**, integration **35/35** (+4 e2e CP MAX). Edge-контур — весь edge-gateway
  **144/144**. Итог по всем этапам M0–M6: путь «клиент ↔ бот организации ↔ менеджер»
  проверен без моков на стыках — app-side (M2/M3) и edge-owned (M4/M5); полный e2e с
  реальной БД/Redis снимается в CI-профиле Testcontainers (локально без Docker —
  предсуществующее ограничение).

---

## 3. Сводка «разрыв → этап → критерий закрытия»

| Разрыв | Этап | Критерий закрытия |
|--------|------|-------------------|
| MG-11 (не задан формат кред) | M0 | `secret://max/<org>/<label>` + состав секрета зафиксированы |
| MG-1 (UI без токена) | M1 | Поле токена MAX на `/channels`, отправка `credentials` |
| MG-2 (фиктивный `:test`) | M1 | Реальная проверка токена MAX, статус по факту |
| MG-3 (нет реального MAX Bot API) | M2 | `createMaxBotApiClient`, реальные методы, `external_message_id` |
| MG-4 (глобальный токен) | M2 | Per-org резолв через `/internal/channels/secret` |
| MG-5 (инертен без env-шлюза) | M2 | MAX регистрируется всегда; ошибка вместо noop |
| MG-6 (нет входящего драйвера) | M3 | `max-inbound-driver` + приёмник, запись inbound |
| MG-7 (нет маппинга бот→org) | M3 | Реестр каналов MAX + резолв организации |
| MG-8 (нет MAX на Edge) | M4 | Бот MAX (приём+отправка) на Edge Gateway |
| MG-9 (нет RF-first) | M5 | RF-first буфер + туннель + дренаж; edge не в mock; edge-драйверы в рантайме |
| Сквозная приёмка | M6 | e2e «MAX: приём и ответ» зелёный |

---

## 4. Что переиспользуется без изменений

Контракт C1/C2 и enum `max`; capability-профиль MAX (C6); DTO `channel_type`;
таблица `channels` + `credentials_envelope` + RLS; `ChannelSecretStore`/
`ChannelSecretService`; S2S-эндпоинты `/internal/channels` и `/internal/channels/secret`;
ядро `acceptIngress`/`handoffEgress`/машина статусов; C7 realtime менеджеру на ingress
(MG-10); manager-workspace (канал-агностичен); движок доставки SVC-INT
(rate-limit/backoff/resilience/идемпотентность); RF-буфер и VPN-туннель Edge;
нормализация `max-adapter`; общий `backend-channels-client`/`ingress-publisher`/`ids`
контура inbound.

---

## 5. Риски и решения к принятию

- **Способ приёма входящих (M3): getUpdates vs webhook.** Long-poll проще (без
  публичного URL), webhook — для прод (требует HTTPS-URL и webhook-secret). Решение
  фиксируется в начале M3; на Edge (M4) меняется только источник апдейтов.
- **Источник токена для приёмника/отправителя.** App-side (M2/M3) — S2S-эндпоинт
  секрета; на Edge (M4) — кэш control-plane (как email E2). Согласовать при переходе.
- **Спецификация MAX Bot API.** Точные эндпоинты/методы/формат токена MAX Bot API
  фиксируются в M1/M2 (влияет на валидацию токена, `:test` и `createExternalPayload`).
- **Хранение секрета (INV-3).** MVP — envelope-поле `channels.credentials_envelope`
  (ключ из env backend), без внешнего Vault/KMS. Ротация ручная.
- **ПДн РФ (M4/M5).** Первичная фиксация входящих субъектов РФ — в RF-контуре;
  порядок «Edge → ядро» обязателен для таких клиентов (ТЗ §7.13/§7.14).
- **Совместимость с заморозкой C2/C6.** Изменения касаются транспорта и хранения
  секрета, не публичных контрактов C1/C2/C6; при необходимости правок — через
  процедуру заморозки (§6 роадмапа).

---

## 6. Что осознанно вне этого плана

- Проактивные карточки менеджеру в MAX (аналог G-8 Telegram) — опционально, вне
  сквозного ядра «приём и ответ».
- SMS/VK/WhatsApp каналы (§4.4 роадмапа — не приоритет).
- Полноценный секрет-менеджер с авто-ротацией и аудитом (`MP-20`, вне MVP).
- Мультипровайдерный роутинг и прочее, не относящееся к каналу MAX.

---

*Документ детализирует боевой путь канала MAX и подчиняется мастер-плану
[`docs/plan/README.md`](./README.md) и роадмапу
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md). Структурно
повторяет эталон [`telegram-channel-production.md`](./telegram-channel-production.md).
При расхождении со сквозными решениями приоритет у мастер-плана; при расхождении с
требованиями — ТЗ [`docs/MessengerBridge_TZ.md`](../MessengerBridge_TZ.md).*
