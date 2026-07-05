# План перевода mock-интеграций в боевой режим — инвентаризация и анализ

**Тип:** исследовательский документ (basis для будущих задач на разработку).
**Дата:** 2026-07-05.
**Область:** весь репозиторий на ветке `issue-201-f89a765260f1` — `services/*`, `apps/*`,
`clients/*`, `packages/*`, `deploy/*`, `db/*`, `scripts/*`, корневые `.env*`, CI.
**Метод:** чтение исходного кода и конфигов (не runtime-прогон). Каждый вывод
сопровождается ссылкой `путь:строка`.

> Документ **не** содержит инструкций по реализации, диффов и оценок трудозатрат в
> человеко-днях/спринтах. Сложность и рискованность даны качественной шкалой
> **Низкая / Средняя / Высокая**. Открытые вопросы сформулированы как вопросы, а не
> как принятые решения (§4). Терминология проекта сохранена (M0–M5, CP-*, SVC-*,
> C1–C10, ТЗ §…).

---

## 0. Ключевые уточнения перед инвентаризацией

Формулировка «в проекте всё замокано» **неточна**. Перепроверка показала три
слоя, которые важно различать, чтобы не завышать и не занижать объём работ.

**(A) Уже реальные транспорты (не мок), работающие при заданном env:**

- **CORE → SVC-INT, C2-egress.** `forwardEgressDelivery` делает реальный `fetch`
  POST на `INTEGRATION_EGRESS_URL`
  (`services/backend/src/modules/communication-core/internal-messaging.service.ts:663-696`;
  URL в `.env.example:76` = `http://integration-platform:3005/internal/egress/deliveries`).
  Без URL — деградация в «только запись статуса в БД».
- **CORE → Telegram Bot API.** Реальные вызовы `api.telegram.org`
  (`services/backend/src/modules/identity/telegram-bot.service.ts:214,295`); без
  `TELEGRAM_BOT_TOKEN` — задокументированная local/CI-деградация
  (`docs/audit/backend-mjs-production-audit.md:70-71`).
- **SVC-INT → CORE, C1-ingress** через `CORE_INGRESS_URL` (`.env.example:71`).
- **SVC-AI → Backend KB-search.** Реальный HTTP на `POST /knowledge:search`
  (`services/ai-platform/src/kb-search.mjs:29-93`), подключён в compose
  (`deploy/compose/docker-compose.yml:98`, `AI_BACKEND_KB_URL`).

То есть «хребет» CORE↔INT по C2 частично реален (реальный транспорт), но
**дальнейшая доставка SVC-INT во внешние каналы — мок** (см. MP-06).

**(B) Production-моки — реальные блокеры перевода в бой** (MP-01…MP-13, MP-18…MP-22):
запускаются в боевом Docker/рантайме и подменяют внешний провайдер, устройство,
канал или межсервисный транспорт.

**(C) Dev/test-моки — норма, не блокеры** (§3.6): MSW в dev-сборках фронтов,
in-process contract-smoke харнесс, детерминированные сиды/фикстуры, тест-серверы.
В production-сборку не попадают; перечислены для полноты инвентаризации.

**(D) Критическая правка к контексту issue.** В контексте issue сказано, что PR
#200 добавляет «реальные OpenAI/Azure-провайдеры для SVC-AI». **На ветке
`issue-1-17113a10fe0c` этих провайдеров нет:** каталог
`services/ai-platform/src/providers/` отсутствует, ключей `OPENAI_API_KEY` /
`AZURE_OPENAI` в репозитории нет, коммит `da59afc` не является предком
`origin/issue-1-17113a10fe0c` (проверено `git merge-base --is-ancestor`). Реальные
LLM-провайдеры существуют только на неслитой ветке
`origin/issue-199-5874dd82d3e0`. Поэтому в текущей базе **весь LLM-транспорт —
детерминированный мок** (MP-07).

---

## 1. Сводная таблица mock-точек

Идентификаторы `MP-NN` используются в §2 (граф) и §3 (детально). Колонка
«Слой» — по классификации из §0 (B — production-mock, C — dev/test-норма).

| ID | Компонент (SVC) | Что мокается | Граница «мок ↔ реальность» (файл) | Слой | Ключевые зависимости |
|----|-----------------|--------------|-----------------------------------|------|----------------------|
| MP-01 | Backend C4 AI-фасад (SVC-CORE/API) | Транспорт backend→SVC-AI | `AI_UPSTREAM_CLIENT` `@Optional()`, **не забинжен** — `ai-integration.module.ts:10-19` | B | MP-07, транспорт backend→фасады, MP-20 |
| MP-02 | Backend C5 FBP-фасад | Транспорт backend→SVC-FBP | `FBP_UPSTREAM_CLIENT` `@Optional()`, **не забинжен** — `fbp-integration.module.ts:9-16` | B | MP-08, транспорт backend→фасады |
| MP-03 | Backend C8 Broadcast-фасад | Транспорт backend→SVC-BCAST | `BROADCAST_UPSTREAM_CLIENT` `useValue:null` — `broadcast-facade.module.ts:16-17` | B | MP-09, транспорт backend→фасады |
| MP-04 | Backend C10 Notification-фасад | Транспорт backend→SVC-NOTIF | `NOTIFICATION_UPSTREAM_CLIENT` `useValue:null` — `notification-facade.module.ts:16-17` | B | MP-10, транспорт backend→фасады |
| MP-05 | Backend C6 Integration Gateway | Каналы/профили целиком | in-memory `Map<string,ChannelFacade>` — `integration-gateway.facade.ts:193`; интерфейса/DI-токена upstream нет | B | MP-06, контрактное решение C6 |
| MP-06 | SVC-INT доставка во внешние каналы | Внешний транспорт всех каналов | `createMockExternalChannel()` — `main.mjs:47`; адаптеры «только формат» | B | Аккаунты провайдеров, MP-20, MP-05 |
| MP-07 | SVC-AI LLM-провайдеры | Реальная LLM-модель (embed/generate) | `createDeterministicMockLlm` — `llm.mjs:43`; 3 фабрики = один мок `main.mjs:66-83` | B | LLM-провайдер+ключи, MP-20, контракт C4-enum |
| MP-08 | SVC-FBP исполнение workflow | Реальный движок FBP | `createDeterministicFbpMock` (deploy), реальный `engine.mjs` — «полочный код» | B | БД M3, согласование интерфейса, MP-02 |
| MP-09 | SVC-BCAST рассылки | Оркестрация + доставка в C1/C2 | `mode:"deterministic-mock"` `server.mjs:27`; mock core-delivery | B | MP-06, C3.clients, MP-03 |
| MP-10 | SVC-NOTIF уведомления | Доставка в каналы web/tg/email/push | `mode:"deterministic-mock"` `server.mjs:29`; адаптеры «только запись» | B | MP-06 (tg), SMTP, MP-11 (push), MP-04 |
| MP-11 | SVC-MOB BFF-бэкенд + push | Backend-транспорт и FCM/APNs | `createMockBackendApi` `backend-client.mjs:20`, `createMockPushProvider` `push-provider.mjs:10` | B | Backend REST, push-ключи, MP-20, MP-19 |
| MP-12 | SVC-EDGE VPN-туннель + WS + RF-буфер | Межсерверный туннель, WS-состояние, RF-персист | `createMockEdgeTunnel` `mock-tunnel.mjs:14`; реальный конвейер — «полочный код» | B | MP-22, VPN Tunnel Service, App-сторона, RF-БД |
| MP-13 | SVC-TGC Telegram Console | Весь клиент (нет боевого входа) | Демо-скрипт `main.mjs:4,12-29`; mock Telegram+backend по умолчанию | B | Реальный Telegram-транспорт, Backend REST (C3/C4/C10) |
| MP-14 | SVC-CHAT web-chat | dev-MSW REST+WS | `enableMockApi: import.meta.env.DEV` — `main.tsx:9` (без флага) | C | Реальные C1/C3/C7 endpoints, MP-06/MP-05 (доставка) |
| MP-15 | SVC-ADMIN saas-admin | dev-MSW REST + mock C7 | `VITE_SAAS_ADMIN_MOCKS` — `main.tsx:8`, `admin.tsx:59-65` | C | Реальные C3/C7/C8/C10 endpoints |
| MP-16 | SVC-MWS manager-workspace | dev-MSW REST+WS | `VITE_MWS_MOCKS` — `main.tsx:8`, `handlers.ts:8` | C | Реальные C3/C7/C10 endpoints |
| MP-17 | C1 mock-схема | Замороженный M0-артефакт схемы | `message-model/c1-message.mock.schema.json` vs канон `index.mjs` | C | Техдолг M0→M1 |
| MP-18 | C2 mock-handoff endpoint | Эгресс без реальной доставки | `communication-core-c2.openapi.json:217,252` `mock_delivery:{const:true}` | B/техдолг | Замещён `/deliveries` (MP-06) |
| MP-19 | MOBILE push-stub | DTO вместо реального push | `MOBILE.PushPayloadStub` — `registry.mjs`; `m0-contract-smoke.test.mjs:254-277` | B | MP-11, push-провайдер |
| MP-20 | Secrets management | Централизованный секрет-менеджер | Плоские заглушки `.env.example:16,40,52`; ТЗ §23.7 не реализован | B (кросс) | Все реальные провайдеры/ключи |
| MP-21 | Слой k8s/helm | staging/prod-оркестрация | `deploy/k8s/` = только `.gitkeep`; ТЗ §25.8 | B (кросс) | Все сервисы, MP-20 |
| MP-22 | Проброс RF-секретов в edge-gateway | env-инъекция ключей RF | `docker-compose.rf.yml:64-68` — только `HOST`/`PORT` | B | MP-12 |

---

## 2. Граф зависимостей и рекомендуемый порядок

Порядок — **логический** (что должно быть готово раньше), без сроков и оценок.

### 2.1. Направленные зависимости (стрелка = «нужно раньше»)

```
                     ┌─────────────────────────────────────────────┐
                     │  Кросс-сквозные enabler'ы                    │
                     │  MP-20 secrets ──► MP-21 k8s                 │
                     │  MP-20 secrets ──► MP-22 RF-инъекция         │
                     │  «транспорт backend→фасады» (не существует)  │
                     └───────┬─────────────────────┬───────────────┘
                             │                     │
        ┌────────────────────┼─────────┐           │
        ▼                    ▼          ▼           ▼
   [MP-05 C6 iface]     [MP-08 FBP] [MP-07 LLM]  [MP-11 push]
        │                    │          │           │
        ▼                    ▼          ▼           ▼
   [MP-06 каналы] ◄──┐  [MP-02 FBP-  [MP-01 AI-  [MP-19 push-DTO]
        │            │   фасад]      фасад]
        ├──────────┐ │
        ▼          ▼ │
   [MP-10 NOTIF] [MP-09 BCAST]
        │          │
        ▼          ▼
   [MP-04 NOTIF- [MP-03 BCAST-
    фасад]        фасад]

   [MP-22]──►[MP-12 SVC-EDGE]──►(VPN Tunnel Service + App-сторона, CP-7)

   [MP-06 tg + Backend REST]──►[MP-13 SVC-TGC]

   (реальные C1/C3/C7/C8/C10 endpoints)──►[MP-14/15/16 фронтенды]
```

### 2.2. Рекомендуемая последовательность рассмотрения

Группы — по логике зависимостей, внутри группы порядок не критичен.

- **Группа A — enabler'ы без продуктовых зависимостей (предшествуют почти всему).**
  MP-20 (секрет-менеджер, ТЗ §23.7) — предпосылка для любого реального ключа
  (LLM, каналы, push, RF). Проектирование **транспорта backend→фасады** (сейчас в
  `services/backend/package.json` нет ни одного HTTP/RPC-клиента — ни `axios`,
  `@nestjs/axios`, `@nestjs/microservices`, `undici`, `got`, `grpc`, `amqp`;
  единственный `fetch` используется лишь в C2-egress и Telegram) — предпосылка для
  MP-01…MP-04. MP-21 (k8s) и MP-22 (проброс RF-секретов) — эксплуатационные
  enabler'ы.
- **Группа B — сервисы с минимальной внешней зависимостью (внутренний транспорт).**
  MP-08 (реальный движок SVC-FBP — уже существует, нужно подключение и БД M3) +
  MP-02. MP-05 (контракт/интерфейс C6 Integration Gateway — самый глубокий мок,
  подводит фундамент под MP-06).
- **Группа C — требуют аккаунтов/ключей внешних провайдеров (продуктовые решения).**
  MP-07 (LLM) + контрактное решение по C4-enum + MP-01; MP-06 (каналы —
  по приоритету каналов); MP-10; MP-11 (push) + MP-19.
- **Группа D — зависят от результатов группы C.** MP-09 (нужны каналы MP-06 и
  реальные получатели из C3.clients) + MP-03; MP-04.
- **Группа E — RF/edge сетевой контур.** MP-12 + VPN Tunnel Service + App-сторона
  туннеля (CP-7, ТЗ §7.8–§7.14).
- **SVC-TGC (MP-13)** — после реального Backend REST и Telegram-транспорта
  (естественно синхронизируется с Telegram-веткой MP-06).
- **Фронтенды (MP-14…MP-16)** — низкий риск: отключение dev-MSW и настройка
  dev-proxy/prod-wiring; выполнимо после появления реальных endpoints.

---

## 3. Разбор по компонентам

Для каждого: **описание** · **граница мок↔реальность** · **что уже есть /
чего нет** · **зависимости** · **контрактные/архитектурные ограничения** ·
**риски (сложность/риск качественно)** · **Definition of Done**.

### 3.1. Backend-фасады (SVC-CORE / SVC-API, NestJS TS)

Общий контекст: backend — модульный NestJS-монолит, собирается в `dist/main.js`
(`docs/audit/backend-mjs-production-audit.md:9-12`). Пять фасадов проксируют
контракты C4/C5/C6/C8/C10, но **живого транспорта к outsourced-сервисам нет**.
`HealthService.getFacadeStatuses()` (`health.service.ts:34-42`) агрегирует
`getStatus()` каждого фасада — они возвращают `mode:"mock"` / `status:"degraded"`.

Resilience-примитивы **готовы и framework-agnostic** —
`services/backend/src/common/resilience/resilience.ts`: `withTimeout`+`FacadeTimeoutError`
(`:24-29,372-391`), `CircuitBreaker` closed/open/half_open (`:56-158`), `Bulkhead`
(`:175-220`), `RetryQueue` (`:257-306`), композитор `FacadeResilience` с
короткозамыканием `no_client` (`:315-369`, `:336-338`). Их надо сохранить при
переходе на реальный транспорт (ТЗ §11.2).

#### MP-01 — C4 AI-интеграция

- **Замокано:** транспорт backend→SVC-AI. Токен `AI_UPSTREAM_CLIENT` объявлен
  (`ai-integration.upstream.ts:24`), инжектится `@Optional()`
  (`ai-integration.controller.ts:43-45`), но **не биндится ни в одном
  DI-модуле** — в `ai-integration.module.ts:10-19` есть только `AiDegradationGuard`
  и сам фасад; даже `useValue:null` отсутствует. Это **точный пример из issue**.
- **Граница:** интерфейс `AiUpstreamClient` (`ai-integration.upstream.ts:17-22`);
  при `undefined`-клиенте `FacadeResilience` отдаёт `fallback_reason:"unavailable"`.
- **Есть:** интерфейс, DTO C4, `AiDegradationGuard` (timeout 250 мс,
  `ai-degradation.guard.ts:15-36`); реальный apply-путь онбординга
  `POST /ai/onboarding:apply` c `actor_type=ai` (`backend-api.controller.ts:58`).
  **Нет:** транспортного клиента и env с адресом/токеном SVC-AI.
- **Зависимости:** MP-07 (реальный LLM в SVC-AI), общий транспорт backend→фасады,
  MP-20.
- **Ограничения:** сохранить timeout 250 мс и degradation guard (ТЗ §11.2);
  контракт C4.
- **Риски:** сложность Средняя, риск Средний (зависит от стабильности/стоимости LLM).
- **DoD:** запрос C4 из backend доходит до реального SVC-AI по сети; при его
  недоступности срабатывает circuit breaker и деградация (не «вечный `no_client`»);
  health перестаёт репортить `mode:"mock"` для C4; e2e с реальным (или стейджинговым)
  SVC-AI зелёный.

#### MP-02 — C5 FBP-интеграция

- **Замокано:** транспорт backend→SVC-FBP. `FBP_UPSTREAM_CLIENT`
  (`fbp-integration.upstream.ts:21`), `@Optional()` (`controller.ts:40-42`), **не
  биндится** (`fbp-integration.module.ts:9-16`). `getStatus()` → `mode:"mock",
  status:"degraded"` (`facade.ts:57-64`). `FacadeResilience` **без retry**.
- **Есть:** интерфейс, DTO C5, resilience. **Нет:** клиента, env.
- **Зависимости:** MP-08, транспорт backend→фасады.
- **Ограничения:** контракт C5; сохранить degradation.
- **Риски:** сложность Средняя, риск Низкий (внутренний сервис, без внешних провайдеров).
- **DoD:** backend вызывает реальный SVC-FBP; статусы исполнения FBP приходят по
  сети; health не `mock` для C5.

#### MP-03 — C8 Broadcast-фасад

- **Замокано:** транспорт backend→SVC-BCAST. `BROADCAST_UPSTREAM_CLIENT`
  забинжен `useValue:null` (`broadcast-facade.module.ts:16-17`) — это осознанный
  seam для `overrideProvider` в тестах. `FacadeResilience` с retry
  `{delayMs:1, maxAttempts:2, maxQueue:16}`.
- **Есть:** интерфейс, DTO C8, resilience с retry. **Нет:** реального клиента, env.
- **Зависимости:** MP-09, транспорт backend→фасады.
- **Ограничения:** контракт C8; сохранить retry/queue-семантику.
- **Риски:** сложность Средняя, риск Средний (зависит от MP-06/MP-09).
- **DoD:** backend управляет реальными рассылками SVC-BCAST по сети; retry/circuit
  breaker работают против реального upstream; health не `mock`.

#### MP-04 — C10 Notification-фасад

- **Замокано:** транспорт backend→SVC-NOTIF. `NOTIFICATION_UPSTREAM_CLIENT`
  `useValue:null` (`notification-facade.module.ts:16-17`). `FacadeResilience` с retry.
- **Есть:** интерфейс, DTO C10, resilience. **Нет:** клиента, env.
- **Зависимости:** MP-10, транспорт backend→фасады.
- **Ограничения:** контракт C10.
- **Риски:** сложность Средняя, риск Средний.
- **DoD:** backend доставляет уведомления через реальный SVC-NOTIF; health не `mock`.

#### MP-05 — C6 Integration Gateway (самый глубокий мок)

- **Замокано:** каналы и capability-профили целиком. **Нет ни upstream-интерфейса,
  ни DI-токена, ни resilience** — чистый in-memory `Map<string,ChannelFacade>`
  (`integration-gateway.facade.ts:193`), 7 захардкоженных capability-профилей
  (`:102-189`). Единственная зависимость — `INTEGRATION_GATEWAY_CLOCK`.
- **Граница:** её фактически нет — в отличие от MP-01…MP-04, seam для реального
  транспорта отсутствует; сначала нужен контракт/интерфейс.
- **Есть:** профили capability, DTO C6. **Нет:** интерфейса upstream, транспорта,
  resilience.
- **Зависимости:** MP-06 (реальные каналы SVC-INT), контрактное решение по C6.
- **Ограничения:** контракт C6.Capability; при вводе реального транспорта —
  добавить resilience по образцу MP-01…MP-04 (ТЗ §11.2).
- **Риски:** сложность Высокая, риск Средний (нужен новый архитектурный seam).
- **DoD:** capability каналов приходят из реального SVC-INT/провайдеров, а не из
  захардкоженной Map; введён интерфейс+resilience; health отражает реальный статус.

### 3.2. Outsourced-сервисы (Node.js ESM `.mjs`)

Общий паттерн (важен для §4): у SVC-FBP и SVC-EDGE **полноценная боевая
реализация уже существует в коде, но подключена только в тестах** — в
`main.mjs`/`server.mjs` разворачивается детерминированный мок («полочный код»).

#### MP-06 — SVC-INT: доставка во внешние каналы

- **Замокано:** внешний сетевой транспорт всех каналов. Два egress-пути, **оба
  мок**:
  1. `POST /internal/delivery/dispatch` (`server.mjs:109`) → `deliveryEngine` →
     `channel.deliver`, где канал = `createMockExternalChannel()` (`main.mjs:47`),
     фиктивный `external_message_id="ext-<channel>-<uuid>"`
     (`mock-external-channel.mjs:90`); `createExternalPayload` **не вызывается** —
     сырой C2 (`delivery-engine.mjs:275-280`). Это канонический async-путь M4/M5
     (202 queued, см. `docs/plan/services/05-integration-platform.md` §5.5).
  2. `POST /internal/egress/deliveries` → `adapter.acceptEgressDelivery`,
     **форматирует** `external_payload` (`m2-channel-adapter.mjs:247`), но клиент —
     NOOP (`m2-channel-adapter.mjs:35,315-319`).
  - **Расхождение:** dispatch имеет resilience, но не форматирует; egress
    форматирует, но клиент-NOOP. Требует согласования (см. §4).
- **Граница:** `createMockExternalChannel` (`main.mjs:47`) / NOOP `externalClient`
  (`m2-channel-adapter.mjs:35`). Реальный сетевой вызов ни в один канал не
  встроен (0 совпадений по `telegram.org|graph.facebook|api.vk.com|nodemailer|smtp|twilio|sendgrid`).
- **Есть:** реальная resilience-обвязка (`resilience.mjs:31-84`, `errors.mjs:60-125`,
  `backoff.mjs:34-53`, `rate-limiter.mjs`), журнал попыток
  (`backend-delivery-client.mjs:39-90`), async retry-queue
  (`delivery-engine.mjs:314-430`); адаптеры Telegram/WhatsApp/SMS/Email/VK/MAX/WebChat
  умеют форматировать payload; VK — нативная идемпотентность
  (`vk-adapter.mjs:143-144`, `random_id=idempotency_key`). **Нет:** реальных
  сетевых клиентов и секретов каналов (env только
  `PORT/HOST/CORE_INGRESS_URL/BACKEND_BASE_URL` + rate/resilience-конфиг).
- **Зависимости:** аккаунты/доступы провайдеров (Telegram Bot API, WhatsApp
  Business API, SMS-агрегатор, SMTP, VK, MAX), MP-20, частично MP-05.
- **Ограничения:** идемпотентность `idempotency_key=message_id` end-to-end
  (ТЗ §11.12); сохранить timeout/circuit breaker/retry/rate-limit (ТЗ §11.2);
  контракты C2/C6.
- **Риски:** сложность Высокая, риск Высокий (внешние API: лимиты, модерация,
  договоры, стоимость; WebChat вообще без realtime-транспорта наружу).
- **DoD (по каждому каналу отдельно):** сообщение реально уходит внешнему
  провайдеру и возвращается **настоящий** `external_message_id`; идемпотентность
  подтверждена (повтор не двоит отправку); resilience срабатывает на реальные
  сбои провайдера; согласовано, какой из двух egress-путей канонический.

#### MP-07 — SVC-AI: LLM-провайдеры

- **Замокано:** реальная LLM-модель. Все пути исполнения заканчиваются в
  `createDeterministicMockLlm` (`llm.mjs:43`): `embed()` = FNV-1a bag-of-words,
  `generate()` = конкатенация шаблонов, `interpretOnboarding()` = keyword→action,
  `available:true` захардкожено. Три фабрики (`deterministic-mock`/`economy`/`premium`)
  — **один и тот же мок**, различаются только именем/ценой
  (`main.mjs:66-83`, «All are deterministic mocks today»).
- **Граница:** фабрика провайдера в `main.mjs:66-83` / роутер провайдеров. Реальный
  провайдер в базе **не существует** (см. §0-D).
- **Есть:** KB-search **уже реальный** (`kb-search.mjs:29-93`, подключён в compose);
  размерность эмбеддинга 1536; контракт C4. **Нет:** реального провайдера, ключей,
  `AI_LLM_CONFIG` в `.env.example`/compose (роутер не активирован).
- **Зависимости:** выбранный LLM-провайдер + ключи, MP-20; **жёсткое контрактное
  ограничение:** `suggestion.mode` enum = `[deterministic_mock, fallback]`
  (`json-schema/c4-ai-assistant-suggest-response.schema.json:60-63`), `generated_by` enum =
  `[deterministic-mock-ai, fallback]`; ответ захардкожен `mode:"deterministic_mock"`
  (`rag-assistant.mjs:102`). **Реальный провайдер невозможно честно промаркировать
  без расширения enum контракта C4.**
- **Ограничения:** контракт C4; резидентность ПДн 152-ФЗ при передаче контента
  внешней модели (ТЗ §7.14).
- **Риски:** сложность Высокая, риск Высокий (стоимость токенов, лимиты,
  приватность ПДн, недетерминизм ответов ломает текущие снапшот-тесты).
- **DoD:** ответ порождён реальной моделью; `mode`/`generated_by` отражают
  реальный провайдер (контракт C4 расширен под это); circuit breaker/timeout на
  провайдера работают; ПДн-политика соблюдена; KB-грounding сохранён.

#### MP-08 — SVC-FBP: исполнение workflow

- **Замокано:** реальный движок. Deploy-путь: `main.mjs`→`server.mjs`→
  `deterministic-fbp.mjs` `createDeterministicFbpMock` (Dockerfile `CMD node
  src/main.mjs`, `Dockerfile:18`). Мок **не обходит узлы** (`deterministic-fbp.mjs:31-42`),
  callback backend_api в режиме `stub` (`:39`), тело узла `{mock:true}` (`:100-116`).
- **Граница:** `createDeterministicFbpMock` (deploy) vs реальный `engine.mjs`
  `createFbpEngine`/`createFbpRuntime` — импортируется **только тестами**.
- **Есть (реально, «полочный код»):** `runGraph` (`core/executor.mjs:29-133`),
  safe-evaluator Transform с whitelist и защитой от prototype-pollution
  (`transform/evaluator.mjs:20`), пиннинг версий (`version-registry.mjs:159-164`,
  `deepFreeze`), журнал = форма `workflow_execution_logs`
  (`execution-context.mjs:226-239`); DDL M3 (`db/migrations/20260703140000000_m3_schema.sql`).
  **Мёртвый код:** `createHttpBackendApiClient` (`backend/client.mjs:19`) — 2
  вхождения в репозитории, оба в своём файле, никогда не инстанцируется.
  **Нет:** подключения движка в рантайм, связи с БД (состояние — in-memory Map).
- **Зависимости:** БД M3, MP-02; **несоответствие интерфейсов** — мок
  (`startWorkflow`/`recordBackendApiCallback`) vs движок
  (`runWorkflow`/`start`/`resume`), адаптера нет.
- **Ограничения:** контракт C5; персистентность в Backend-owned таблицах
  (`instance-store.mjs` как референс-модель).
- **Риски:** сложность Высокая, риск Низкий/Средний (внешних провайдеров нет,
  но нужно свести два интерфейса и подключить БД).
- **DoD:** workflow исполняется реальным движком (узлы обходятся, Transform
  считается), состояние персистится в БД, а не в памяти; интерфейс мок/движок
  сведён; C5 стабилен.

#### MP-09 — SVC-BCAST: рассылки

- **Замокано:** полностью in-memory (`mode:"deterministic-mock"`, `server.mjs:27`),
  1 сид `broadcast-1` (`:20-52`), БД нет. Транспорт = мок ядра C1/C2
  (`campaign/in-memory-core-delivery.mjs`, egress по умолчанию
  `async ()=>({accepted:true,status:"sent"})` `:17-19`). Планировщик **не
  исполняется** (`deterministic-broadcast.mjs:171-201`, нет таймера/cron).
  Получатели = 3 фейковых клиента (`:293-314`), не из C3.clients.
  `createBroadcastDeliveryCoordinator` существует **только как строка в
  комментарии** — реальной реализации нет; интеграционные/e2e-тесты переинжектят мок.
- **Граница:** `in-memory-core-delivery.mjs` vs реальная оркестрация `campaign/*`
  (runner, token-bucket rate-limiter, backoff, stats, capability, template-renderer,
  idempotency, C7-события) — инжектируемая, **нигде не подключена**.
- **Есть:** реальная оркестрация (инжектируемая). **Нет:** реальной доставки в C1/C2,
  БД, исполняемого планировщика, реальных получателей.
- **Зависимости:** MP-06 (фактическая доставка), C3.clients (получатели), MP-03.
- **Ограничения:** идемпотентность (ТЗ §11.12); C7 realtime-события кампании;
  rate-limit провайдеров.
- **Риски:** сложность Высокая, риск Средний.
- **DoD:** кампания реально доставляется через C1/C2 живым каналам; получатели из
  C3.clients; планировщик исполняется; идемпотентность и rate-limit подтверждены.

#### MP-10 — SVC-NOTIF: уведомления

- **Замокано:** полностью in-memory (`mode:"deterministic-mock"`, `server.mjs:29`),
  5 Map + сид `notification-m0-1`. События продюсятся HTTP-вызовом
  `POST /internal/notifications/events` (`server.mjs:75`), **не через шину** (нет
  kafka/amqp/nats). Каналы web/telegram/email/push (`channel-adapters.mjs`) — **только
  запись в память** (`:31-57` web, `:87-118` tg/email/push пишут `provider_ref` без
  отправки); провайдеры-заглушки `svc-tgc`/`smtp-gateway`/`push-gateway`.
- **Граница:** `channel-adapters.mjs` (запись) vs реальные провайдеры (нет).
- **Есть:** реальные routing/dedup/retry/settings. **Замечание:** `dedupeKeyOf`
  конкатенирует без разделителя (`:478-480`) — теоретическая коллизия ключей.
  **Нет:** реальной доставки, шины событий.
- **Зависимости:** MP-06 (telegram-канал), SMTP (email), MP-11 (push), MP-04.
- **Ограничения:** контракт C10; идемпотентность/дедуп.
- **Риски:** сложность Средняя, риск Средний.
- **DoD:** уведомление реально доставляется по каждому каналу; дедуп без коллизий;
  решён вопрос «HTTP-продюсер vs шина».

#### MP-11 — SVC-MOB: mobile-api (BFF + push)

- **Замокано:** даже в боевом Docker (`NODE_ENV=production`) — мок-обвязка.
  `createMockBackendApi` (`backend-client.mjs:20`, in-memory C3.*/C10),
  `createMockPushProvider` (`push-provider.mjs:10`, без APNs/FCM),
  `createDeterministicMobileApiMock` (fallback при `MOBILE_API_MODE=mock`).
  `main.mjs:9-10`: `useBff=(MOBILE_API_MODE ?? "bff")!=="mock"`. WS-канала нет
  (`mobile-bff.mjs:46`, `wsChannel ?? null`).
- **Граница:** `createMockBackendApi`/`createMockPushProvider` vs реальные
  клиенты. **Расхождение метки и реальности:** BFF-ответы помечены `mock:false`
  поверх мок-бэкенда.
- **Есть:** реальные `push-dispatcher` (retries 3, деактивация dead-token),
  `push-payload` (сборка FCM/APNs), `device-registry`, `realtime-consumer`.
  **Нет:** реального HTTP-клиента к Backend (нет `BACKEND_URL` env), реальных
  APNs/FCM-клиентов, WS-канала.
- **Зависимости:** Backend REST, ключи FCM/APNs, MP-20, MP-19, контракт MOBILE.v1.
- **Ограничения:** контракт MOBILE.v1; корректная маркировка `mock`.
- **Риски:** сложность Высокая, риск Высокий (нужны Apple/Google-доступы, реальные
  устройства для проверки).
- **DoD:** BFF читает реальный Backend; push реально доставляется на устройство
  через FCM/APNs; dead-token деактивируется; `mock:false` соответствует
  действительности.

#### MP-12 — SVC-EDGE: edge-gateway (VPN-туннель + WS + RF-буфер)

- **Замокано:** в проде — мок-обвязка. `createMockEdgeTunnel` (`mock-tunnel.mjs:14`),
  `createMockWebSocketChannel` (`mock-ws-channel.mjs:91`); состояние — только в
  памяти.
- **Граница:** мок-туннель/канал vs реальный RF-first конвейер, подключённый
  **только в тестах** (`edge-cluster.test.mjs:78-107`).
- **Есть (реально, «полочный код»):** `createEdgeCluster` (`edge-cluster.mjs:36`),
  VPN Tunnel (`vpn-tunnel.mjs:191/325` — mTLS, AES-256-GCM, HKDF,
  `EDGE_VPN_SESSION_KEY`), буфер in-memory (`edge-message-buffer.mjs:137`) и Postgres
  (`:319`), шифр RF-payload (`rf-payload-cipher.mjs:75/168`, `EDGE_BUFFER_ENCRYPTION_KEY`),
  DDL (`db/rf-migrations/20260703151000000_m4_edge_message_buffer.sql`). **Но:** туннель
  работает поверх in-process `createVpnLink` (`:164`), **не TCP/TLS-сокета**; в
  `docker-compose.rf.yml` привязка к сокету явно отложена. **Нет:** сетевого
  демона VPN Tunnel Service (в compose намеренно не поднят,
  `docker-compose.rf.yml:9-18`), App-стороны туннеля, `DATABASE_URL` у edge-gateway
  (буфер не используется — см. MP-22).
- **Зависимости:** MP-22 (проброс RF-секретов), VPN Tunnel Service, App-сторона,
  RF-БД.
- **Ограничения:** резидентность 152-ФЗ / RF-first запись ПДн до трансграничной
  репликации (ТЗ §7.14); контракт C9.EdgeTunnelMessage; CP-7.
- **Риски:** сложность Высокая, риск Высокий (реальная межсерверная криптосеть).
- **DoD:** туннель работает через реальный TCP/TLS-сокет между App и RF; RF-буфер
  персистится в Postgres; ключи приходят из секрет-менеджера; RF-first порядок
  записи подтверждён.

#### MP-13 — SVC-TGC: Telegram Console

- **Замокано:** **весь клиент** — боевого входа нет. `main.mjs` — демо-скрипт:
  инжектит `createMockTelegramApiAdapter` (`:4`) и подаёт 2 захардкоженных
  Update-объекта (`:12-29`), печатает результат (`:31-43`). `mock-telegram-api.mjs`
  складывает payload в массивы, возвращает `message_id:"mock-message-N"`, `mock:true`
  (`:47,53`) — без HTTP. Backend по умолчанию — in-memory мок
  (`handler-router.mjs:61-62`), логин-код `"000000"` захардкожен (`:33`).
- **Граница:** инъекция `telegramApi`/`backendApi` в роутер; единственный
  вызывающий (`main.mjs:7-10`) всегда передаёт мок; переключателя «мок/бой» и env нет.
- **Есть:** транспортно-агностичный роутер (`handler-router.mjs:80-107`), надёжная
  доставка `createReliableTelegramApiAdapter` (`telegram-delivery.mjs:22-98`,
  rate-limit+retry — уже обёрнута вокруг мока). **Нет:** клиента `api.telegram.org`,
  `getUpdates`/webhook, чтения токена, процесса-демона, реального Backend-клиента.
  Черновик привязки помечен `real_auth_performed:false, mock:true`
  (`account-linking.mjs:32-33`).
- **Зависимости:** реальный Telegram-транспорт (совместно с MP-06 telegram),
  Backend REST (C3/C4/C10). **C7 (WS) вне scope намеренно** (`scope.mjs:26-32`) —
  уведомления доставляются push-методом C10.
- **Ограничения:** контракты C3/C4/C10; идемпотентность `messages.create`.
- **Риски:** сложность Высокая, риск Высокий (нужен полноценный боевой процесс-хост).
- **DoD:** есть боевой процесс (getUpdates **или** webhook) с чтением токена;
  команды идут в реальный Backend; отправка — через реальный Telegram Bot API.

### 3.3. Контрактные mock-артефакты (packages/contracts)

Runnable mock-провайдеров в `packages/contracts` **нет** — пакет содержит только
схемы/валидаторы + два замороженных M0-артефакта:

#### MP-17 — C1 mock-схема

- `message-model/c1-message.mock.schema.json` (title «C1 Message Model M0 Mock»)
  со старыми именами полей (`message_id`, `channel_id`, `direction:inbound/outbound`),
  сосуществует с каноном `validateCanonicalMessage`
  (`message-model/index.mjs`, `MESSAGE_MODEL_VERSION="1.0.0"`, поля
  `id`/`endpoint_id`/`sender_type` + машина статусов). Слой C (техдолг M0→M1).
- **DoD/вопрос:** мок-схема удалена либо явно согласована как отдельный
  M0-freeze-артефакт; канон и мок не расходятся.

#### MP-18 — C2 mock-handoff endpoint

- `communication-core-c2.openapi.json` — endpoint `/internal/egress/messages`
  (summary «Core → Adapter egress handoff without real delivery»),
  `EgressHandoffResponse.mock_delivery:{const:true}`, `delivery_status:{const:"sent"}`
  (`:217,252`) — доставка фиктивна. **Боевой путь** эгресса —
  `/internal/egress/deliveries` (через `INTEGRATION_EGRESS_URL`), уже
  проверяется contract-smoke (`tests/contract/m0-contract-smoke.test.mjs:67-99`).
- **Зависимости:** замещается MP-06.
- **DoD/вопрос:** судьба `/internal/egress/messages` после перехода на `/deliveries`
  (удалить или оставить как M0-артефакт).

#### MP-19 — MOBILE.PushPayloadStub

- DTO-заглушка: регистрация устройства возвращает `push_payload_stub` вместо
  реальной отправки (`registry.mjs` MOBILE.v1; smoke ждёт
  `push_payload_stub.contract==="MOBILE.PushPayloadStub"`,
  `m0-contract-smoke.test.mjs:254-277`).
- **Зависимости:** MP-11; push-провайдер; ключи FCM/APNs (в `.env.example` их нет).
- **DoD:** контракт возвращает реальный результат отправки push, а не stub-DTO.

### 3.4. Инфраструктура и эксплуатация (кросс-сквозные)

#### MP-20 — Secrets management (ТЗ §23.7)

- **Замокано/отсутствует:** централизованного секрет-менеджера (Vault/KMS/SOPS/
  sealed-secrets) нет; секреты — плоские заглушки: `POSTGRES_PASSWORD=bridge`
  (`.env.example:16`), `BRIDGE_AUTH_SECRET=change-me-…` (`:40`), пустой
  `TELEGRAM_BOT_TOKEN=` (`:52`); в RF — `EDGE_BUFFER_ENCRYPTION_KEY` (`.env.rf.example:37`),
  `EDGE_VPN_SESSION_KEY` (`:42`), причём файл сам декларирует, что секреты «должны
  приходить из секрет-менеджера, а НЕ коммититься» (`:13-15`).
- **Есть:** принцип «конфиг только через env» (ТЗ §25.10) соблюдён; резолверы
  секретов централизованы и **бросают исключение при отсутствии**
  (`rf-payload-cipher.mjs:168-183`, `vpn-tunnel.mjs:87-99`); compose требует
  `AUTH_HASH_SECRET` обязательным (`docker-compose.yml:77`). **Нет:** самого
  менеджера, ротации, разыменования `channels.credentials_ref` (ссылка на секрет,
  не сам секрет).
- **Зависимости:** предпосылка для всех реальных ключей (MP-06/07/11/12).
- **Риски:** сложность Средняя, риск Высокий (безопасность ПДн, 152-ФЗ).
- **DoD:** секреты выдаются из выбранного менеджера; в репозитории/образах нет
  плоских боевых значений; ротация описана.

#### MP-21 — Слой k8s/helm

- **Отсутствует полностью:** `deploy/k8s/` = только `.gitkeep`; ни Deployment/
  Service/Ingress/Secret/ConfigMap/HPA, ни helm-чартов. staging/prod-слой (ТЗ §25.8,
  master §3/§9.2) не реализован.
- **Есть:** 13 реальных Dockerfile с HEALTHCHECK (`deploy/docker/*`), два
  docker-compose-кластера. **Нет:** k8s-манифестов/чартов, разбивки staging→prod.
- **Зависимости:** все сервисы; MP-20 (secrets в k8s).
- **Риски:** сложность Высокая, риск Средний.
- **DoD:** есть k8s-манифесты/чарты для всех сервисов, разделение окружений,
  интеграция с секрет-менеджером.

#### MP-22 — Проброс RF-секретов в edge-gateway

- **Разрыв инъекции:** сервис `edge-gateway` в RF-compose получает в environment
  **только** `HOST` и `PORT` (`docker-compose.rf.yml:64-68`), без `env_file` —
  `EDGE_BUFFER_ENCRYPTION_KEY`/`EDGE_VPN_SESSION_KEY` в контейнер **не попадают**, а
  `DATABASE_URL` не задан → Postgres-буфер не используется. При вызове крипто-путей
  резолверы бросят исключение (`rf-payload-cipher.mjs:168-183`,
  `vpn-tunnel.mjs:87-99`).
- **Зависимости:** MP-12, MP-20.
- **Риски:** сложность Низкая, риск Средний.
- **DoD:** RF-секреты и `DATABASE_URL` пробрасываются в контейнер (env_file/
  секрет-менеджер); RF-буфер и туннель поднимаются без падения по отсутствию ключей.

**VPN Tunnel Service как сетевой сервис** намеренно не поднят ни в одном кластере,
чтобы не создавать ложного впечатления готового канала
(`docker-compose.rf.yml:9-18`); App-стороны туннеля в `docker-compose.yml` нет.
Это — часть MP-12/CP-7, а не отдельная mock-точка.

### 3.5. Фронтенды (dev-MSW) — MP-14…MP-16

Во всех трёх React-приложениях **боевой REST/WS-клиент уже основной**
(`@bridge/api-client`, база `/api/v1`, tenant-заголовок `x-organization-id`);
мок активен **только в dev** и в production-сборку не входит. Поэтому это слой C
(не рантайм-блокер), но есть общие пробелы wiring.

- **MP-14 SVC-CHAT (web-chat):** MSW REST+WS под `enableMockApi:
  import.meta.env.DEV` (`main.tsx:9`) — **без именованного флага**, мок во всех
  dev-сборках; `ws.link` C7 (`mocks/handlers.ts:14`), захардкоженный «ответ
  менеджера» (`:213`). Боевые клиенты — всегда в виджете (`WebChatWidget.tsx:55-62,282`),
  реальный WS с reconnect+`last_event_id` (`realtimeClient.ts:37`), Edge-проход C9
  (`edgeConnection.ts:33`). Зависимости: реальные C1/C3/C7 endpoints, опционально
  SVC-EDGE.
- **MP-15 SVC-ADMIN (saas-admin):** MSW REST под `VITE_SAAS_ADMIN_MOCKS`
  (`main.tsx:8`) + **подмена реализации** C7-клиента
  (`createMockC7RealtimeClient`, `realtime.ts:25`; ветвление `admin.tsx:59-65`).
  Боевой C7 — `createBrowserC7RealtimeClient` (`realtime.ts:53`), но **без
  resume/reconnect** (`:82-84`) — в отличие от MWS/CHAT. dev-`server.proxy`
  отсутствует (только `preview.proxy`, `vite.config.ts:32-39`).
- **MP-16 SVC-MWS (manager-workspace):** MSW REST+WS (`ws.link`, `handlers.ts:8`)
  под `VITE_MWS_MOCKS` (`main.tsx:8`). Боевые дефолты — **реальные** клиенты без
  флаговой ветки (`workspace.tsx:19-22`), полноценный C7 с reconnect+resume
  (`realtime.ts:24,27`), слияние realtime с dedupe по `event_id`
  (`realtime-merge.ts`). dev-proxy отсутствует.
- **Общие ограничения:** контракты C3/C7/C8/C10; конверты `C7.WebSocketEvent`.
- **Риски:** сложность Низкая, риск Низкий.
- **DoD:** флаги моков документированы (или удалены), выбрана dev-стратегия
  доступа к боевому Backend (proxy), в production-сборке MSW заведомо отсутствует,
  C7-клиент админки уравнен по resume/reconnect (если это признано пробелом, а не
  осознанным упрощением).

### 3.6. Слой C (норма — не блокеры перевода в бой)

Перечислено для полноты инвентаризации; это **не** production-моки:

- **Contract-smoke харнесс** — `tests/contract/m0-contract-smoke.test.mjs:289-302`
  поднимает реальные in-process серверы сервисов только внутри теста (contract-gate).
- **Детерминированные сиды/фикстуры** — `packages/testing/src/db/m0-seed-data.mjs`,
  `db/seeds/000001_m0_seed.mjs` (фиксированные UUID, `M0_SEED_TIMESTAMP`); применяются
  реальным идемпотентным сидером (`scripts/db-seed.mjs`).
- **Тест-фабрики и анонимизация ПДн** — `packages/testing/src/db/factories.mjs`,
  `anonymization.mjs` (реальная data-ops логика 152-ФЗ, не мок).
- **api-client** — реальный ручной JSON-клиент (`packages/api-client/src/index.mjs`),
  **не** мок; расхождение план↔факт: мастер-план называет его «сгенерированным из
  OpenAPI», но генерации нет (техдолг, см. §4).
- **MSW-конфиг фронтов** — dev-only (`package.json` msw.workerDirectory).
- **CI-заглушки** — `scripts/ci-placeholder.mjs` — **сирота**, не вызывается из
  `package.json`; CI фактически гоняет реальные `test:contract`/`test:e2e`. Имена
  шагов «placeholder» — техдолг именования.
- **ui-kit** — пустой каркас (`packages/ui-kit`, `.gitkeep`), `lint/test/build`
  делегированы в no-op `scripts/workspace-command.mjs`.

---

## 4. Сводный список открытых вопросов (до старта работ)

Требуют решения продукта/архитектора. Сформулированы как вопросы.

**LLM / SVC-AI (MP-07, MP-01):**
1. Какой LLM-провайдер выбран основным (OpenAI / Azure OpenAI / российский /
   self-hosted)? Нужен ли мультипровайдерный роутинг по организациям в проде или
   это over-engineering для текущего масштаба?
2. Как расширить контракт C4: `suggestion.mode`/`generated_by` сейчас допускают
   только `deterministic_mock`/`fallback` — какой enum-код честно обозначит ответ
   реальной модели? Без этого реальный ответ придётся маркировать как
   `deterministic_mock`.
3. Допустима ли передача ПДн клиентов во внешнюю модель с точки зрения 152-ФЗ
   (ТЗ §7.14), или требуется self-hosted/RF-размещённая модель?

**Каналы / SVC-INT (MP-06, MP-05):**
4. Какие каналы доставки в приоритете (Telegram / WhatsApp / SMS / Email / VK /
   MAX)? По каким уже есть реальные аккаунты/договоры/бизнес-доступы?
5. Какой из двух egress-путей SVC-INT канонический для прода —
   `/internal/delivery/dispatch` (async, есть resilience, нет форматирования) или
   `/internal/egress/deliveries` (форматирует, но клиент-NOOP), и как их свести?
6. Нужен ли реальный realtime-транспорт для WebChat-канала (сейчас у него нет
   хука `externalClient`)?

**Push / Mobile (MP-11, MP-19):**
7. Какой push-провайдер (FCM/APNs) и где хранятся ключи (секрет-менеджер, §23.7)?
8. BFF-ответы SVC-MOB помечены `mock:false` поверх мок-бэкенда — это осознанная
   семантика или расхождение, которое нужно исправить?

**Транспорт backend↔фасады (MP-01…MP-04):**
9. Какой транспорт между backend и outsourced-сервисами (HTTP/REST, gRPC,
   message bus)? Сейчас в `services/backend/package.json` нет ни одного клиента —
   это фундаментальное архитектурное решение до реализации любого фасада.

**FBP / SVC-FBP (MP-08):**
10. Какой интерфейс канонический — мок (`startWorkflow`/`recordBackendApiCallback`)
    или движок (`runWorkflow`/`start`/`resume`), и кто владелец таблиц состояния
    (Backend-owned по образцу `instance-store.mjs`)?

**Notification (MP-10):**
11. Продюсер событий уведомлений — остаётся HTTP `POST
    /internal/notifications/events` или переходит на реальную шину (kafka/amqp/nats)?

**Edge / RF (MP-12, MP-22):**
12. Когда поднимается реальный межсерверный VPN (CP-7): milestone привязки к TCP/TLS-
    сокету, появление App-стороны туннеля, проброс RF-секретов и `DATABASE_URL` в
    edge-gateway?

**Secrets / инфраструктура (MP-20, MP-21):**
13. Какой секрет-менеджер выбран (Vault/KMS/SOPS/…), как устроена ротация и
    разыменование `channels.credentials_ref`?
14. На какой вехе создаётся k8s/helm-слой и как в нём управляются секреты?
15. Нужны ли на текущей вехе инфраструктурные сервисы вне каталога 15 из §2
    мастер-плана (object storage/S3, кэш/Redis, брокер) — их нет ни в compose, ни в
    env?

**Контрактный техдолг (MP-17, MP-18, §3.6):**
16. Судьба M0-мок-артефактов после M1: удалить `c1-message.mock.schema.json` и
    endpoint `/internal/egress/messages`, или зафиксировать как freeze-артефакты?
17. Переходит ли `@bridge/api-client` на кодогенерацию из OpenAPI (как в
    мастер-плане) или ручной клиент закрепляется официально?

**Фронтенды (MP-14…MP-16):**
18. Документировать ли флаги `VITE_SAAS_ADMIN_MOCKS`/`VITE_MWS_MOCKS` в
    `.env.example` и какую dev-стратегию доступа к боевому Backend выбрать (нет
    dev-proxy)? Привязка web-chat-мока к `import.meta.env.DEV` без флага —
    осознанна?
19. Отсутствие resume/reconnect в боевом C7-клиенте SVC-ADMIN — пробел или
    осознанное упрощение?

---

## 5. Что осталось непроверенным / не входит в это исследование

- **Runtime-прогон не выполнялся.** Все выводы — из чтения кода и конфигов, не из
  фактического запуска docker-compose/сервисов. Поведение «полочного» реального
  кода (SVC-FBP `engine.mjs`, SVC-EDGE `edge-cluster.mjs`) подтверждено только
  наличием и тестами, не production-прогоном; наличие ≠ production-ready.
- **Другие ветки, кроме `issue-201-f89a765260f1`, не анализировались подробно.**
  Проверен лишь факт, что реальные LLM-провайдеры (PR #200 / ветка
  `origin/issue-199-5874dd82d3e0`) в текущую базу **не слиты** (§0-D).
- **Внешние API вне репозитория** (Telegram Bot API, WhatsApp Business API,
  SMS-агрегаторы, SMTP, VK, MAX, LLM-провайдеры, FCM/APNs): их реальные лимиты,
  стоимость, требования модерации, условия договоров и SLA — вне кода и требуют
  уточнения у продукта.
- **Полнота тест-покрытия каждого реального компонента** не аудировалась —
  фиксировался факт существования реализации, не её зрелость.
- **Конкретные версии/выбор SDK внешних провайдеров** не определялись (в
  репозитории их нет).
- **Данный документ не назначает вехи/сроки и не оценивает трудозатраты** — только
  инвентаризация, зависимости, риски и критерии готовности; последовательность в §2
  логическая, не календарная.
