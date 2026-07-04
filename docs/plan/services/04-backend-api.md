---
title: План разработки — Backend API и доменные модули
service: Backend API и доменные модули
service_id: SVC-API
version: 1.0
status: Draft
language: ru-RU
based_on: docs/MessengerBridge_TZ.md (§11, §16, §22.3, §22.9)
master_plan: docs/plan/README.md
---

# SVC-API — Backend API и доменные модули

**SVC-API** — единая публичная точка входа платформы (ТЗ §11.1, §11.3): все
операции чтения и изменения данных выполняются исключительно через Backend API,
ни один клиентский компонент не имеет прямого доступа к БД. Сервис предоставляет
три категории интерфейсов (ТЗ §11.5): **REST API** (для UI и внешних систем),
**WebSocket API** (события реального времени, совместно с ядром) и **Internal
Service API** (для внутренних компонентов). SVC-API — модуль синхронного ядра
(модульный монолит на NestJS, ТЗ §11.2), и именно ядро — единственный владелец
доступа к PostgreSQL (ТЗ §22.3): вынесенные сервисы работают только через Backend
API. К деградируемым сервисам (AI, FBP, Broadcast, Notification) SVC-API обращается
через **тонкие фасады** с таймаутами, circuit breaker и bulkhead (ТЗ §11.2), чтобы
их недоступность не влияла на обработку сообщений (ТЗ §5.1, §5.4).

SVC-API — **владелец каркаса контракта C3** (REST-фреймворк: единый формат ошибок,
пагинация/фильтрация/поиск, версионирование в URL, автоген OpenAPI) и доменных
CRUD-модулей (Organization, User-домен, Client, Knowledge Base, Configuration,
Audit). Аутентификацию и эндпоинты `auth`/`platform` ведёт **SVC-IDN**; жизненный
цикл сообщений, Conversation, идентификацию клиентов — **SVC-CORE**; SVC-API их
эндпоинты не дублирует, а предоставляет через общий каркас (см. §3). Сервис
участвует в **CP-1**, **CP-3**, **CP-4**, **CP-5** (мастер-план §6).

> Модель данных и контракты **не переопределяются** в этом плане — авторитетны
> мастер-план §4 (схема БД) и §7 (каталог контрактов). Здесь детализируются только
> фреймворк API, доменные CRUD-модули и фасады к вынесенным сервисам.

---

## 1. Назначение и границы

**В зоне ответственности SVC-API:**

- **Фреймворк REST API** (ТЗ §11.6): единообразный набор операций на каждый ресурс
  (создание/получение/изменение/удаление/поиск/фильтрация/пагинация).
  - серверная валидация всех входящих запросов (ТЗ §11.10): обязательные поля,
    типы, длины, допустимые значения, **принадлежность данных организации**, права;
    недопустимые запросы не достигают бизнес-логики;
  - **единый формат ошибок** (ТЗ §11.11): код, краткое описание, человекочитаемое
    сообщение, идентификатор запроса, диагностика; единый для всех модулей;
  - **пагинация / фильтрация / поиск** как общий каркас (ТЗ §11.6, §22.8);
  - **версионирование в URL** `/api/v1` (ТЗ §11.8): ломающие изменения — только
    новая версия;
  - формат данных JSON / UUID / ISO-8601 UTC / UTF-8 (ТЗ §11.9);
  - **идемпотентность** операций создания (ТЗ §11.12) через сквозной ключ;
  - **автогенерация OpenAPI/Swagger из кода** (ТЗ §11.14) как часть поставки;
  - единообразное логирование запросов/ответов/длительности/request-id (ТЗ §11.13).
- **Доменные CRUD-модули** (ТЗ §11.3, §16): Organization Management, User-домен
  (совместно с SVC-IDN), Client Management (совместно с SVC-CORE), Knowledge Base,
  Configuration (+ история), Audit.
- **Фасады к вынесенным сервисам** (ТЗ §11.2, §11.3): `ai-integration` (C4),
  `fbp-integration` (C5), `broadcast-facade` (C8), `notification-facade` (C10) —
  инкапсулируют вызовы контрактов, **таймаут / circuit breaker / bulkhead** и
  деградацию.
- **health / metrics** на сервисе (ТЗ §24.4, мастер §7.2).

**Вне зоны ответственности** (границы):

- SVC-API **не реализует** адаптеры каналов, логику AI, логику исполнения Workflow,
  формирование Broadcast или доставку Notification — только **контрактные вызовы**
  к соответствующим сервисам.
- Аутентификация, сессии, роли, RBAC-guard'ы, эндпоинты `auth`/`platform` — **SVC-IDN**
  (мастер §7.2, группы `C3.auth`, `C3.platform`). SVC-API применяет предоставленные
  guard'ы, но не реализует их.
- Модель сообщения, приём/маршрутизация, Conversation, identity resolution,
  идемпотентность сообщений на пути доставки — **SVC-CORE** (ТЗ §8). Эндпоинты
  `C3.conversations`/`C3.messages`/`C7.ws` принадлежат ядру; SVC-API отдаёт их
  через общий REST-каркас, проксируя к внутреннему сервису CORE.
- Физическая модель БД и миграции — **SVC-DATA** (мастер §4).

---

## 2. Технологии

| Область | Решение | Обоснование / ссылка |
|---|---|---|
| Каркас приложения | **NestJS** (модульный монолит) | ТЗ §11.2, §27.1; модули через внутренние сервисные интерфейсы (ТЗ §11.4) |
| Валидация запросов | **class-validator** + class-transformer, глобальный `ValidationPipe` | серверная валидация ТЗ §11.10; whitelist + forbidNonWhitelisted |
| Документация API | **OpenAPI/Swagger**, автоген из декораторов кода → `packages/contracts/openapi` | ТЗ §11.14; документация — часть поставки |
| Версионирование | стратегия **URI Versioning** (`/api/v1`) | ТЗ §11.8; ломающие изменения — новая версия |
| Формат ошибок | глобальный `ExceptionFilter` → единый DTO (code/description/humanMessage/requestId/diagnostics) | ТЗ §11.11 |
| Пагинация/фильтр/поиск | общий `PaginationInterceptor` + query-DTO (limit/cursor, filter, q) | ТЗ §11.6, §22.8 |
| Идемпотентность | `IdempotencyInterceptor` + таблица ключей (окно дедупликации) | ТЗ §11.12 |
| Устойчивость фасадов | **timeout** на все внешние вызовы, **circuit breaker**, **bulkhead** (ограничение параллелизма), очередь с ретраями | ТЗ §11.2 |
| Realtime | WebSocket-шлюз (эмиссия событий C7; транспорт — SVC-CORE/EDGE) | ТЗ §11.7, мастер §7.3 |
| Доступ к БД | ORM/репозитории поверх PostgreSQL 16 + pgvector | ТЗ §22.2–§22.3; схема — SVC-DATA |
| Тесты | Jest (unit), Jest + Testcontainers (integration) | ТЗ §26.3–§26.4, мастер §3.1 |

---

## 3. Интерфейсы и контракты

### 3.1 Экспортирует (владелец каркаса C3)

SVC-API поставляет **общий каркас** для всех групп C3: единый формат ошибок,
единую пагинацию/фильтрацию, версионирование, автоген OpenAPI. Владеет доменными
группами, участвует в совместных, отдаёт эндпоинты ядра/интеграций через каркас
(мастер §7.2). Каждый эндпоинт покрыт минимум одним **integration-тестом**:
**happy-path + изоляция арендатора + ошибка валидации** (мастер §8.3).

| Группа (C3) | Основные эндпоинты v1 | Владелец логики | Роль SVC-API |
|---|---|---|---|
| **C3.org** | `GET/PATCH /organizations/{id}`, `GET/PUT /organizations/{id}/configuration` | SVC-API | владелец |
| **C3.users** | `GET/POST /organizations/{id}/users`, `PATCH /users/{id}`, `POST /users/{id}/sessions:revoke`, `POST /invitations` | SVC-IDN + API | совместно (CRUD-фасад над IDN) |
| **C3.clients** | `GET/POST /clients`, `GET /clients/{id}`, `POST /clients/{id}/endpoints`, `POST /clients:merge`, `POST /clients/{id}/notes`, `POST /clients/{id}/tags` | SVC-CORE + API | совместно (notes/tags — API; merge/endpoints — CORE) |
| **C3.kb** | `GET/POST /knowledge/documents`, `POST /knowledge/documents/{id}:reindex`, `POST /knowledge:search` (internal для AI) | SVC-API | владелец |
| **C3.channels** | `GET/POST /channels`, `POST /channels/{id}:test`, `GET /channels/{id}/capabilities` | SVC-INT + API | совместно (REST-фасад над INT) |
| **C3.conversations** | `GET /conversations`, `GET /conversations/{id}`, `GET /conversations/{id}/messages` | SVC-CORE | отдаёт через каркас (проксирование) |
| **C3.messages** | `POST /messages` (идемпотентно, ТЗ §11.12), `GET /messages/{id}` | SVC-CORE | отдаёт через каркас (проксирование) |
| **health/metrics** | `GET /health`, `GET /metrics` | все | владелец на своём процессе |

Общесистемные артефакты, поставляемые SVC-API как каркас C3:

- **Единый формат ошибки** (DTO): `{ code, description, humanMessage, requestId, diagnostics? }`.
- **Единый конверт пагинации**: `{ items[], page: { limit, nextCursor?, total? } }` + query-параметры фильтра и `q` (поиск).
- **Соглашения версионирования** (`/api/v1`) и правила совместимости (мастер §7.4).
- **OpenAPI-спецификация** Backend API в `packages/contracts/openapi` (автоген, ТЗ §11.14).

### 3.2 Потребляет (через фасады и внутренние интерфейсы)

| Контракт | Направление | Источник | Механизм устойчивости |
|---|---|---|---|
| **C4** (AI request/response, KB search) | API → AI | SVC-AI | timeout + circuit breaker + bulkhead; деградация «AI недоступен» |
| **C5** (FBP start + Backend API node) | API ↔ FBP | SVC-FBP | timeout + circuit breaker; узел Backend API возвращает результат Workflow (ТЗ §13.5) |
| **C8** (Broadcast) | API → BCAST | SVC-BCAST | timeout + очередь с ретраями; деградация без падения ядра |
| **C10** (Notification) | API → NOTIF | SVC-NOTIF | timeout + bulkhead; деградация без падения ядра |
| Схема БД + миграции | — | SVC-DATA | репозитории поверх единой схемы (мастер §4) |
| Внутренний сервис CORE | внутримодульно (NestJS) | SVC-CORE | публичный интерфейс модуля (ТЗ §11.4) для проксирования диалогов/сообщений |
| Guard'ы авторизации | внутримодульно (NestJS) | SVC-IDN | проверка сессии/роли/принадлежности организации (ТЗ §9.8) |

> Фасады **не** содержат бизнес-логики вынесенных сервисов — только контрактный
> вызов, преобразование DTO, таймаут/circuit breaker/bulkhead и деградацию.

---

## 4. Модель данных

Владелец схемы — SVC-DATA; ниже перечислены таблицы (мастер §4.1/§4.9), которыми
**владеет домен SVC-API** (или совместно), с указанием этапа появления. Каждая
арендо-зависимая таблица содержит `organization_id NOT NULL` и проверяется на
изоляцию (ТЗ §22.6, мастер §4).

| Таблица | Назначение | Владелец | Этап |
|---|---|---|---|
| `organizations` | организации/арендаторы (ТЗ §22.4) | SVC-DATA/API | M1 |
| `configurations` | конфигурация организации `(organization_id, key) UNIQUE` | SVC-API | M1 |
| `configuration_history` | историчность конфигурации (ТЗ §22.10) | SVC-API | M1 |
| `audit_events` | append-only журнал аудита (ТЗ §22.9, §23.8) | SVC-DATA/API | M1 (запись), M3 (интеграция с фасадами) |
| `client_notes` | заметки о клиенте | SVC-API | M1 |
| `client_tags` | теги клиента | SVC-API | M1 |
| `knowledge_documents` | документы базы знаний (статус индексации) | SVC-API/AI | M2 |
| `knowledge_chunks` | чанки + `embedding vector(1536)` (pgvector) | SVC-API/AI (совм.) | M2 |

> `clients`, `communication_endpoints`, `conversations`, `messages` — владелец
> **SVC-CORE** (мастер §4.3–§4.4). SVC-API работает с ними только через публичный
> интерфейс модуля CORE. `knowledge_chunks.embedding` наполняется совместно с
> SVC-AI: SVC-API владеет CRUD документов и хранением, SVC-AI — эмбеддингами и
> семантическим поиском (мастер §4.9, §4.11).

---

## 5. Поэтапный план

Этапы привязаны к общим вехам M0…M5 (мастер §5). Оценки — в условных единицах (S/M/L/XL).

### M0 — Каркас API и контракт C3 (L)

- **Цель.** Зелёный CI на скелете Backend; каркас REST-фреймворка и заготовка
  OpenAPI заморожены как основа контракта C3; моки фасадов подняты.
- **Задачи.**
  1. NestJS-приложение, версионирование `/api/v1` (ТЗ §11.8), базовая структура модулей и `common/` (фильтры, guards, interceptors).
  2. Глобальный `ValidationPipe` (ТЗ §11.10) и **единый формат ошибок** через `ExceptionFilter` (ТЗ §11.11).
  3. Middleware/interceptor **пагинации, фильтрации, поиска** (ТЗ §11.6) — общий каркас query-DTO.
  4. **Идемпотентный POST** (ТЗ §11.12): `IdempotencyInterceptor` + хранилище ключей.
  5. Автоген **OpenAPI/Swagger из кода** (ТЗ §11.14) в `packages/contracts/openapi`; единообразное логирование (ТЗ §11.13).
  6. `GET /health`, `GET /metrics` (ТЗ §24.4); заглушки-контракты фасадов AI/FBP/BCAST/NOTIF.
- **Тесты.** *Unit*: формат ошибок, валидаторы каркаса, преобразователи пагинации, генерация request-id, логика идемпотентности. *Integration*: поднятие приложения + PostgreSQL (Testcontainers), `/health`. *E2e*: — (общий старт M0).
- **DoD.** OpenAPI-каркас в `packages/contracts`; единый формат ошибок и пагинации применяются глобально; зелёный `lint→unit→integration`; контракт C3 (каркас) заморожен (мастер §9.4).

### M1 — Доменные CRUD + проксирование ядра (XL) — CP-1

- **Цель.** Базовый REST для сквозного среза «приём и ответ»: доменные CRUD и
  отдача Conversation/Message через каркас.
- **Задачи.**
  1. **Organization Management**: `GET/PATCH /organizations/{id}` (ТЗ §16.3).
  2. **Configuration** + история: `GET/PUT /organizations/{id}/configuration` c записью в `configuration_history` (ТЗ §22.10).
  3. **Client Management** (домен API-части): `GET/POST /clients`, `GET /clients/{id}`, `POST /clients/{id}/notes`, `POST /clients/{id}/tags`; операции `endpoints`/`merge` — проксирование к SVC-CORE.
  4. **User-домен** (совместно с SVC-IDN): CRUD-фасад `GET/POST /organizations/{id}/users`, `PATCH /users/{id}` (ТЗ §16.4).
  5. **Проксирование к CORE**: `GET /conversations`, `GET /conversations/{id}`, `GET /conversations/{id}/messages`, `GET /messages/{id}`; `POST /messages` — идемпотентная передача в ядро (ТЗ §11.12).
  6. Запись `audit_events` для изменяющих операций (ТЗ §22.9).
- **Тесты.** *Unit*: DTO-валидаторы клиентов/конфигурации, преобразователи, версионирование конфигурации. *Integration*: Backend↔PostgreSQL для каждого ресурса — **happy-path + изоляция арендатора + ошибка валидации** (мастер §8.3); проксирование Backend↔CORE через публичный интерфейс. *E2e*: участие в «Работа менеджера» и «Web Chat: приём и ответ» (мастер §8.2).
- **DoD.** Каждый эндпоинт домена покрыт integration-тестом (3 случая); изоляция арендатора (ТЗ §22.6) и валидация (ТЗ §11.10) соблюдены; аудит пишется; **CP-1** пройдена (см. §6); контракт C3 (base) заморожен.

**Статус реализации CP-1.** M1 Backend API завершён: C3 base опубликован в
`packages/contracts/openapi/backend-core/openapi.json`, C3.auth — в
`packages/contracts/openapi/auth/c3.auth.openapi.json`, consumer contracts
SVC-MWS/SVC-ADMIN закреплены в `packages/contracts/consumer/`, а доменные
CRUD/proxy, tenant isolation, идемпотентный `POST /messages` и аудит
изменяющих операций покрыты `services/backend/test/integration/m1-domain-api.spec.ts`.

### M2 — Knowledge Base API (L) — CP-3

- **Цель.** CRUD документов базы знаний и internal-поиск для AI.
- **Задачи.**
  1. `GET/POST /knowledge/documents`, удаление/обновление, статус индексации (ТЗ §16.6).
  2. `POST /knowledge/documents/{id}:reindex` — постановка переиндексации (взаимодействие с SVC-AI по наполнению `knowledge_chunks`).
  3. `POST /knowledge:search` — **internal** семантический поиск для AI (изоляция по `organization_id`, ТЗ §12.7, §22.7).
- **Тесты.** *Unit*: валидаторы документов, маппинг статусов индексации. *Integration*: Backend↔PostgreSQL (документы, изоляция арендатора); Backend↔AI по контракту KB-search через мок (мастер §8.1, ТЗ §26.4). *E2e*: участие в «AI Assistant из KB» (мастер §8.2).
- **DoD.** KB-эндпоинты покрыты integration-тестами (3 случая); поиск изолирован по арендатору; контракт `C3.kb` стабилизирован для CP-3.

**Статус реализации M2.** M2 Backend API завершён для CP-3: C3.kb search
используется AI-пайплайном через Backend-only доступ к KB, consumer contract
`packages/contracts/consumer/ai-integration-c4.consumer.v1.json` фиксирует
ожидания API как потребителя C4 и поставщика `C3.kb`, а
`tests/integration/ai-rag-kb.test.mjs` проверяет реальный pgvector/RLS-путь без
утечки чужого `organization_id`. C4 зафиксирован как `stable_for_m3` в
`packages/contracts/cp2-cp3-freeze.v1.json`; M3-фасады остаются следующим scope
для полноценного circuit breaker/bulkhead.

### M3 — Фасады AI и FBP + интеграция аудита (XL) — CP-3, CP-4, CP-5

- **Цель.** Тонкие фасады `ai-integration` (C4) и `fbp-integration` (C5) с полными
  паттернами устойчивости; закрепление узла Backend API как единственного
  санкционированного способа менять данные из Workflow.
- **Задачи.**
  1. Фасад **ai-integration** (C4): `POST /ai/assistant:suggest` через SVC-AI; **timeout + circuit breaker + bulkhead** (ТЗ §11.2); деградация «AI недоступен» без влияния на переписку (ТЗ §5.4).
  2. Фасад **fbp-integration** (C5): запуск Workflow и **узел Backend API** — приём запроса Workflow, проверка полномочий текущего пользователя, применение бизнес-логики, возврат результата (ТЗ §13.5); те же паттерны устойчивости.
  3. **Интеграция аудита** (ТЗ §22.9): действия, инициированные AI Onboarding и Workflow, фиксируются с `actor_type = ai|workflow` в `audit_events`.
  4. Единая деградация фасадов: недоступность вынесенного сервиса → корректный ответ ошибкой в едином формате (ТЗ §11.11), без падения ядра.
- **Тесты.** *Unit*: **логика circuit breaker** (open/half-open/closed), таймауты, bulkhead-лимиты, преобразователи DTO фасадов; валидация структурированной команды AI (ТЗ §12.6). *Integration*: Backend↔AI и Backend↔FBP через **моки контрактов** (мастер §8.4, ТЗ §26.4); узел Backend API применяет изменение с проверкой прав и пишет аудит. *E2e*: «AI Assistant из KB», «Workflow вызывает Backend API» (мастер §8.2).
- **DoD.** Фасады AI/FBP реализованы с timeout/circuit breaker/bulkhead; деградация проверена; аудит действий AI/Workflow пишется; **CP-3, CP-4, CP-5** пройдены (см. §6); контракты C4/C5 стабилизированы вместе с C3.

**Статус реализации M3 (M3-04).** M3 Backend API завершён для CP-4/CP-5. Тонкие
фасады `ai-integration` (C4) и `fbp-integration` (C5) обёрнуты в общий
`common/resilience/resilience.ts` (timeout + circuit breaker + bulkhead, ТЗ §11.2)
и единую деградацию без падения ядра (ТЗ §11.11): контроллеры
`services/backend/src/modules/ai-integration/ai-integration.controller.ts` и
`services/backend/src/modules/fbp-integration/fbp-integration.controller.ts`.
Узел **Backend API** — единственный санкционированный путь изменения данных из
Workflow/AI (ТЗ §13.5): `modules/backend-api/backend-api.controller.ts`
(`POST /ai/onboarding:apply`, `POST /workflows/backend-api-node:invoke`) через
`workflow-action-applier.service.ts` валидирует структурированную команду по
JSON-схеме §12.6, проверяет права по **реальному принципалу** (никогда по
самодекларированным ролям контекста Workflow) и пишет `audit_events` с
`actor_type = ai|workflow` (ТЗ §12.6, §22.9). Покрытие: unit
`test/unit/resilience.spec.ts` (состояния circuit breaker, таймауты, bulkhead),
`test/unit/*-integration.facade.spec.ts` (преобразователи DTO фасадов) и
`test/unit/workflow-action-applier.spec.ts` (валидация §12.6 и audit actor_type),
integration
`test/integration/m3-facades.spec.ts` (Backend↔AI/FBP, применение изменения с
проверкой прав и аудитом на реальном Postgres/RLS), contract
`tests/contract/cp4-cp5-freeze.test.mjs` (C5 freeze на CP-4, C3+C4+C5
стабилизация на CP-5), e2e
`tests/e2e/facades-cp4-cp5.test.mjs` («Workflow вызывает Backend API»,
«AI Onboarding применяет конфигурацию») и
`tests/e2e/workflow-engine-cp4-cp5.test.mjs` («Admin правит Workflow»).
C3/C4/C5 зафиксированы как `stable_for_m4` в
`packages/contracts/cp4-cp5-freeze.v1.json`; пять новых операций опубликованы в
`packages/contracts/openapi/backend-core/openapi.json`. Следующий scope M4:
сквозная идемпотентность, Broadcast/Notification фасады (C8/C10), Mobile API и
Telegram Console.

### M4 — Фасады Broadcast и Notification (M)

- **Цель.** Тонкие фасады `broadcast-facade` (C8) и `notification-facade` (C10).
- **Задачи.**
  1. Фасад **broadcast-facade** (C8): `POST /broadcasts`, `POST /broadcasts/{id}:start`, `GET /broadcasts/{id}/stats` — контрактный вызов SVC-BCAST; идемпотентное создание (ТЗ §11.12).
  2. Фасад **notification-facade** (C10): `GET /notifications`, `POST /notifications/{id}:read`, `GET/PUT /notifications/settings` — контрактный вызов SVC-NOTIF.
  3. Устойчивость: timeout + очередь с ретраями + bulkhead; деградация без падения ядра.
- **Тесты.** *Unit*: валидаторы DTO broadcast/notification, идемпотентность создания, логика деградации. *Integration*: Backend↔BCAST и Backend↔NOTIF через моки контрактов; эндпоинты покрыты 3 случаями. *E2e*: участие в «Broadcast: доставка кампании» и «Notification в Web + Telegram».
- **DoD.** Фасады BCAST/NOTIF реализованы; деградация проверена; эндпоинты покрыты integration-тестами.

**Статус реализации M4 (M4-99).** M4 Backend API завершён для CP-6/CP-8: фасады
`broadcast-facade` (C8) и `notification-facade` (C10) проксируют вызовы в
SVC-BCAST и SVC-NOTIF по замороженным контрактам, идемпотентное создание и
деградация без блокировки ядра. Контракты C8/C10 стабилизированы `stable_for_m5`
(`packages/contracts/cp6-cp7-freeze.v1.json`, `packages/contracts/cp8-freeze.v1.json`,
скреплено `tests/contract/m4-gate-freeze.test.mjs`). Покрытие: e2e
`tests/e2e/facades-cp6-cp8.test.mjs`, contract
`tests/contract/c8-broadcast-contract.test.mjs`,
`tests/contract/c10-notification-contract.test.mjs`.

### M5 — Полнота OpenAPI и контроль версии API (M) — стабилизация

- **Цель.** Полнота и корректность контракта, нагрузочная проверка NFR.
- **Задачи.**
  1. Полнота **OpenAPI** (ТЗ §11.14): каждый эндпоинт задокументирован, спецификация соответствует фактическому API.
  2. **Контроль версии API**: проверка совместимости `/api/v1`; регламент ломающих изменений (мастер §7.4, §9.3).
  3. **Нагрузочная проверка NFR** по ориентирам ТЗ §25.2 (списки диалогов ≤ 1 с, история ≤ 2 с, отправка ≤ 1 с, ответ AI без LLM ≤ 500 мс и т. д.).
- **Тесты.** *Unit*: полнота декораторов OpenAPI. *Integration*: контрактная проверка «OpenAPI ↔ фактический API»; регрессия изоляции арендатора по всем ресурсам. *E2e*: полный набор сценариев вехи M5 (мастер §8.2), участие в приёмке (CP-9).
- **DoD.** OpenAPI полна и синхронна с кодом; версия API под контролем; ориентиры §25.2 достигнуты в нагрузочной пробе; регрессия зелёная (мастер §9.4).

**Статус реализации M5 (M5-04).** M5 Backend API завершён для CP-9:
`packages/contracts/openapi/backend-core/openapi.json` генерируется из
NestJS-кода (`npm run build --workspace @bridge/backend`) и содержит M5-метаданные
C3 (`x-contract-id`, `x-owner`, `x-stage`, `x-api-version`,
`x-api-version-strategy`). Полнота декораторов закреплена в
`services/backend/test/unit/openapi-decorators.spec.ts`: каждый контроллер имеет
`@ApiTags`, а каждый route handler — `@ApiOperation`, Swagger response decorator
и `@Version("1")`. Синхронизация «фактический API ↔ OpenAPI» закреплена в
`services/backend/test/integration/m5-openapi-contract.spec.ts`: все реальные
маршруты `/api/v1` опубликованы в контракте, а единственные неверсированные
операционные alias — `GET /health` и `GET /metrics`. NFR-пороги ТЗ §25.2
зафиксированы p95-пробами в `services/backend/test/integration/m5-nfr.spec.ts`
(список диалогов ≤ 1 с, история ≤ 2 с, отправка ≤ 1 с, AI без внешнего LLM
≤ 500 мс). Приёмочный артефакт CP-9 опубликован как
`packages/contracts/cp9-svc-api-acceptance.v1.json` и проверяется contract-тестом
`tests/contract/cp9-svc-api-acceptance.test.mjs`.

---

## 6. Точки согласования

### CP-1 (M1) — базовый REST для сквозного среза

- **Ожидания.** SVC-CORE отдаёт приём/хранение сообщений и Conversation через
  публичный интерфейс; SVC-IDN — сессии/guard'ы; SVC-INT(Web Chat) — приём; SVC-MWS —
  отображение. SVC-API предоставляет доменные CRUD и каркас C3.
- **Замораживаемый контракт.** **C3 (Backend REST core)**: единый формат ошибок,
  пагинация/фильтрация, версионирование; совместно с C1 (Message Model), C2, C7.
- **Межсервисные тесты.** e2e «Web Chat: приём и ответ», «Работа менеджера»;
  contract INT↔CORE; integration Backend↔PostgreSQL и Backend↔CORE (проксирование).

### CP-3 (M2/M3) — фасад к SVC-AI

- **Ожидания.** SVC-AI реализует C4 (assistant + KB-search); SVC-DATA — KB/pgvector;
  SVC-MWS/CHAT — UI ассистента. SVC-API предоставляет `C3.kb` и фасад `ai-integration`.
- **Замораживаемый контракт.** **C4** (AI request/response, KB search) поверх
  стабилизированного C3.
- **Межсервисные тесты.** e2e «AI Assistant из KB»; contract API↔AI; проверка
  **деградации** при недоступности SVC-AI (переписка продолжается).

### CP-4 (M3) — фасад к SVC-FBP, узел Backend API

- **Ожидания.** SVC-FBP реализует C5 (start Workflow + вызов узла Backend API).
  SVC-API — **единственный санкционированный способ менять данные** из Workflow:
  узел Backend API проверяет полномочия и применяет бизнес-логику (ТЗ §13.5, §13.13).
- **Замораживаемый контракт.** **C5** (FBP start + Backend API node) поверх C3.
- **Межсервисные тесты.** e2e «Workflow вызывает Backend API»; contract API↔FBP;
  проверка, что изменение данных из Workflow проходит проверку прав и пишет аудит.

### CP-5 (M3) — стабилизация C3/C4/C5

- **Ожидания.** SVC-ADMIN использует визуальный редактор Workflow; SVC-AI(Onboarding)
  применяет конфигурацию через Backend API. SVC-API стабилизирует связку C3+C4+C5.
- **Замораживаемый контракт.** **C3 + C4 + C5** (совместная стабилизация).
- **Межсервисные тесты.** e2e «Admin правит Workflow», «AI Onboarding применяет
  конфиг»; проверка применения структурированной команды AI через Backend API (ТЗ §12.6).

### CP-9 (M5) — приемка SVC-API

- **Ожидания.** SVC-API публикует полный и синхронный C3 OpenAPI из кода, держит
  стабильный `/api/v1` и подтверждает NFR-ориентиры ТЗ §25.2 на автоматических
  пробах без времени внешнего LLM.
- **Замораживаемый контракт.** **C3 Backend REST API v1.0.0**:
  `packages/contracts/openapi/backend-core/openapi.json` +
  `packages/contracts/cp9-svc-api-acceptance.v1.json`.
- **Межсервисные тесты.** contract CP-9, unit полноты Swagger-декораторов,
  integration «OpenAPI ↔ фактические маршруты» и NFR p95-пробы.

---

## 7. Стратегия тестирования

Соответствует мастер §8 и ТЗ §26. Разработка без автотестов не допускается (ТЗ §26.1).

- **Единый формат ошибок на всех эндпоинтах.** Контрактная проверка, что любая
  ошибка возвращает `{ code, description, humanMessage, requestId, diagnostics? }`
  (ТЗ §11.11) — для валидации, авторизации, деградации фасадов.
- **Пагинация и фильтрация.** Проверка граничных случаев (пустая/последняя страница,
  курсор), корректности фильтров и поиска `q` (ТЗ §11.6).
- **Изоляция арендатора на каждом ресурсе.** Для каждого публичного эндпоинта —
  тест, что данные чужой организации недоступны (ТЗ §22.6, мастер §8.3): обязательный
  третий случай в наборе «happy-path + изоляция + ошибка валидации».
- **Поведение circuit breaker.** Unit-тесты переходов open/half-open/closed,
  срабатывания таймаутов и bulkhead-лимитов; integration-проверка **деградации без
  падения ядра** при недоступности вынесенного сервиса (ТЗ §11.2, §5.4).
- **Соответствие OpenAPI фактическому API.** Автогенерация из кода (ТЗ §11.14) +
  контрактный тест «спецификация ↔ реальные ответы»; расхождение — ошибка сборки.
- **Integration-связки** (ТЗ §26.4): Backend↔PostgreSQL, Backend↔CORE, Backend↔AI,
  Backend↔FBP, Backend↔BCAST/NOTIF — реальная БД через Testcontainers, вынесенные
  сервисы через контрактные моки (мастер §8.1, §8.4).

---

## 8. Риски и зависимости

| Риск / зависимость | Влияние | Митигирование (где) |
|---|---|---|
| Монолит как единая точка отказа модулей | Нарушение «Communication First» (ТЗ §5.1) | Вынос деградируемых сервисов через **фасады** с timeout/circuit breaker/bulkhead (ТЗ §11.2); ядро продолжает приём/доставку при их недоступности — M3/M4, §7 |
| Рассинхронизация OpenAPI и кода | Ложный контракт, дрейф C3 | **Автоген OpenAPI из кода** (ТЗ §11.14) + контрактный тест «спецификация ↔ API» — M0/M5, §7 |
| Каскадные таймауты при недоступности вынесенного сервиса | Исчерпание пулов, падение ядра | **Bulkhead** (ограничение параллелизма) + circuit breaker + очередь с ретраями (ТЗ §11.2) — M3/M4 |
| Узел Backend API как единственный путь изменения данных из Workflow | Обход проверок прав / прямой доступ AI к БД | Все изменения — только через Backend API с проверкой полномочий и аудитом (ТЗ §5.11, §12.5, §13.5); e2e «Workflow вызывает Backend API» — CP-4 |
| Дрейф контрактов при параллельной разработке | Ломает интеграцию на CP | Contract-first (M0), contract-тесты (мастер §8.4), заморозка на CP-1/CP-3/CP-4/CP-5 |
| Зависимость от SVC-DATA (схема) и SVC-CORE (интерфейс) | Блокировка домена | Работа против моков/публичных интерфейсов до готовности; SVC-DATA — на критическом пути (мастер §10.1) |
| Изоляция арендаторов упущена на новом ресурсе | Утечка данных между организациями (ТЗ §22.6) | Обязательный тест изоляции на каждом эндпоинте (мастер §8.3); RLS по `organization_id` на уровне БД (мастер §4) |

---

*План ссылается на мастер-план [`../README.md`](../README.md) и ТЗ
[`../../MessengerBridge_TZ.md`](../../MessengerBridge_TZ.md). При расхождении
приоритет имеет ТЗ. Документ подлежит актуализации по мере прохождения вех.*
