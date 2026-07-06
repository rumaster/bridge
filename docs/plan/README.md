---
title: Поэтапный план разработки Communication Platform
subtitle: Общий план, структура проекта, модель данных, контракты и точки согласования сервисов
version: 1.0
status: Draft
language: ru-RU
based_on: docs/MessengerBridge_TZ.md (v1.1)
---

# Поэтапный план разработки Communication Platform

Настоящий документ — **общий (мастер-) план** разработки платформы
*Communication Platform with Programmable Automation and AI* (рабочий репозиторий
`bridge`). План основан на техническом задании
[`docs/MessengerBridge_TZ.md`](../MessengerBridge_TZ.md) (версия 1.1) и учитывает
замечания ревью [`docs/MessengerBridge_TZ_Review.md`](../MessengerBridge_TZ_Review.md).

Мастер-план является **единым источником истины** для сквозных решений: структуры
репозитория, модели данных, каталога контрактов и API, общих вех и точек
согласования между сервисами. Планы отдельных сервисов лежат в
[`docs/plan/services/`](./services/) и **ссылаются** на разделы настоящего
документа, детализируя свой участок работ.

> Все ссылки вида «ТЗ §7.10» относятся к техническому заданию; ссылки вида
> «§ 3» — к разделам настоящего плана; ссылки вида «CP-1» — к точкам согласования
> (§ 6); «M0…M5» — к общим вехам (§ 5).

---

# Содержание

1. Цели, принципы и методология планирования
2. Декомпозиция на сервисы (единицы параллельной разработки)
3. Структура проекта (код и тесты)
4. Модель данных (структура БД всех сервисов)
5. Общие вехи (milestones) и дорожная карта
6. Точки согласования сервисов (coordination points) и межсервисные тесты
7. Каталог контрактов и API (интерфейсы всех сервисов)
8. Стратегия тестирования (unit / integration / e2e / contract)
9. CI/CD, окружения и Definition of Done
10. Управление рисками и зависимостями
11. Навигация по планам сервисов

---

# 1. Цели, принципы и методология планирования

## 1.1 Цель плана

Обеспечить **параллельную и независимую** разработку всех подсистем платформы
при гарантии их совместимости. Для этого:

- каждая подсистема (сервис) имеет отдельный поэтапный план в
  [`docs/plan/services/`](./services/);
- сервисы синхронизируются только в явно обозначенных **точках согласования**
  (§ 6), где ожидается готовность этапов смежных сервисов и добавляются
  **межсервисные тесты**;
- между точками согласования каждая команда разрабатывает свой сервис
  автономно — против **замороженных контрактов** (§ 7) и их моков.

## 1.2 Принципы планирования

| Принцип | Следствие для плана |
|---|---|
| **Contract-first** | Контракты (OpenAPI, модель сообщения, схемы событий) фиксируются в вехе M0 до реализации; разработка идёт против моков контрактов. |
| **Communication First** (ТЗ §5.1) | Критический путь «приём → хранение → доставка сообщения» реализуется первым (веха M1) и не зависит от вспомогательных сервисов. |
| **Вертикальные срезы** | Каждая веха даёт работающий сквозной сценарий, покрытый e2e-тестом, а не «горизонтальный слой». |
| **Деградируемость** (ТЗ §5.4, §11.2) | Вынесенные сервисы (AI, FBP, Adapters, Broadcast, Notification, WS Gateway) подключаются к ядру через контракты и моки; их отсутствие не блокирует разработку ядра. |
| **Тестируемость** (ТЗ §26) | Ни один этап не считается завершённым без unit-, integration- и (на точках согласования) e2e-тестов. |
| **Изоляция арендаторов** (ТЗ §22.6) | `organization_id` присутствует в каждой арендо-зависимой сущности и проверяется на уровне Backend с самого начала. |

## 1.3 Методология

- **Trunk-based** разработка с короткоживущими ветками на сервис; общий CI (§ 9).
- Каждая веха завершается **демо сквозного сценария** и заморозкой изменившихся
  контрактов (semver контрактов, ломающие изменения — только новая версия, ТЗ §11.8).
- **Definition of Done** для этапа (§ 9.4) единый для всех сервисов.
- Оценки трудозатрат в планах приводятся в **условных единицах** (S/M/L/XL), а не
  в календарных сроках, поскольку профиль команды не задан.

---

# 2. Декомпозиция на сервисы (единицы параллельной разработки)

Декомпозиция следует двухуровневой архитектуре ТЗ (§11.2): **синхронное ядро**
(модульный монолит на NestJS) и **вынесенные деградируемые сервисы**, плюс
фронтенд-приложения и клиентские интерфейсы. Каждый сервис ниже имеет отдельный
план и разрабатывается параллельно.

| ID | Сервис | Уровень (ТЗ §11.2) | План | Ключевые разделы ТЗ |
|----|--------|--------------------|------|---------------------|
| SVC-DATA | Data Platform (БД, миграции, pgvector, изоляция) | Фундамент | [01-data-platform.md](./services/01-data-platform.md) | §22 |
| SVC-IDN | Identity Platform (аутентификация, сессии, роли, bootstrap) | Ядро | [02-identity-platform.md](./services/02-identity-platform.md) | §9, §23 |
| SVC-CORE | Communication Core (жизненный цикл сообщений, Conversation, маршрутизация, идентификация) | Ядро | [03-communication-core.md](./services/03-communication-core.md) | §8, §7.10 |
| SVC-API | Backend API и доменные модули (Organization/User/Client/KB/Configuration/Audit), фреймворк API | Ядро | [04-backend-api.md](./services/04-backend-api.md) | §11, §16 |
| SVC-INT | Integration Platform (Adapters: Telegram/MAX/VK/WhatsApp/Email/SMS), Capability Model | Вынесенный | [05-integration-platform.md](./services/05-integration-platform.md) | §10 |
| SVC-AI | AI Platform (AI Assistant, AI Onboarding, абстракция LLM) | Вынесенный | [06-ai-platform.md](./services/06-ai-platform.md) | §12 |
| SVC-FBP | FBP Engine (форк и переработка fbp-engine) | Вынесенный | [07-fbp-engine.md](./services/07-fbp-engine.md) | §13 |
| SVC-BCAST | Broadcast Platform (массовые коммуникации) | Вынесенный | [08-broadcast-platform.md](./services/08-broadcast-platform.md) | §14 |
| SVC-NOTIF | Notification Platform (внутренние уведомления) | Вынесенный | [09-notification-platform.md](./services/09-notification-platform.md) | §15 |
| SVC-EDGE | Edge Cluster, WebSocket Gateway, VPN Tunnel, буферизация | Вынесенный | [10-edge-websocket-gateway.md](./services/10-edge-websocket-gateway.md) | §7, §11.7 |
| SVC-ADMIN | SaaS Administration (Frontend) | Фронтенд | [11-saas-administration.md](./services/11-saas-administration.md) | §16, §21 |
| SVC-MWS | Manager Workspace (Frontend) | Фронтенд | [12-manager-workspace.md](./services/12-manager-workspace.md) | §17, §21 |
| SVC-CHAT | Web Chat (Frontend + Web Chat Endpoint) | Фронтенд | [13-web-chat.md](./services/13-web-chat.md) | §18 |
| SVC-TGC | Telegram Console (клиентский интерфейс менеджера) | Клиент | [14-telegram-console.md](./services/14-telegram-console.md) | §20 |
| SVC-MOB | Mobile API (BFF для мобильных приложений) | Клиент | [15-mobile-api.md](./services/15-mobile-api.md) | §19 |

**Замечание о ядре.** SVC-IDN, SVC-CORE, SVC-API — модули **одного** развёртываемого
процесса (модульный монолит, ТЗ §11.2–§11.4), но у них разные границы
ответственности и они разрабатываются разными командами через внутренние
сервисные интерфейсы NestJS (ТЗ §11.4). Data Platform (SVC-DATA) поставляет им
единую схему БД и миграции.

---

# 3. Структура проекта (код и тесты)

Проект организуется как **монорепозиторий** (workspaces). Структура отражает
границы сервисов (§ 2) и раздельно размещает код, unit-, integration- и e2e-тесты
(требование issue). Backend — модульный монолит (ТЗ §27.1); фронтенды — React +
Vite (ТЗ §21, §27.2).

```text
bridge/                              # корень репозитория
├── apps/                            # Frontend-приложения (React + Vite + TS)
│   ├── saas-admin/                  # SVC-ADMIN
│   │   ├── src/
│   │   └── test/                    # unit (Vitest), component (Testing Library)
│   ├── manager-workspace/           # SVC-MWS
│   └── web-chat/                    # SVC-CHAT (frontend-часть)
│
├── services/                        # Backend и вынесенные сервисы
│   ├── backend/                     # СИНХРОННОЕ ЯДРО (NestJS Modular Monolith)
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── identity/         # SVC-IDN
│   │   │   │   ├── communication-core/  # SVC-CORE
│   │   │   │   ├── organization/     # SVC-API (домен)
│   │   │   │   ├── user/             # SVC-API
│   │   │   │   ├── client/           # SVC-API
│   │   │   │   ├── conversation/     # SVC-CORE/API
│   │   │   │   ├── message/          # SVC-CORE/API
│   │   │   │   ├── knowledge-base/   # SVC-API
│   │   │   │   ├── configuration/    # SVC-API
│   │   │   │   ├── audit/            # SVC-API
│   │   │   │   ├── ai-integration/   # тонкий фасад к SVC-AI
│   │   │   │   ├── fbp-integration/  # тонкий фасад к SVC-FBP
│   │   │   │   ├── integration-gateway/  # фасад к SVC-INT (Adapters)
│   │   │   │   ├── broadcast-facade/ # фасад к SVC-BCAST
│   │   │   │   └── notification-facade/  # фасад к SVC-NOTIF
│   │   │   ├── common/               # фильтры ошибок, guards, interceptors, idempotency
│   │   │   └── main.ts
│   │   └── test/
│   │       ├── unit/                 # *.spec.ts (Jest), без внешних сервисов (ТЗ §26.3)
│   │       └── integration/          # Backend↔PostgreSQL, ↔WS (Testcontainers, ТЗ §26.4)
│   │
│   ├── integration-platform/        # SVC-INT: Adapters
│   │   ├── src/adapters/{telegram,max,vk,whatsapp,web-chat,email,sms}/
│   │   ├── src/capability/          # Capability Model (ТЗ §10.6)
│   │   └── test/{unit,integration}/
│   ├── ai-platform/                 # SVC-AI (Assistant + Onboarding + LLM-абстракция)
│   ├── fbp-engine/                  # SVC-FBP (форк fbp-engine, ТЗ §13.13)
│   ├── broadcast-platform/          # SVC-BCAST
│   ├── notification-platform/       # SVC-NOTIF
│   ├── edge-gateway/                # SVC-EDGE: WebSocket Gateway + буфер (RF-контур)
│   └── mobile-api/                  # SVC-MOB: BFF (может быть модулем backend)
│
├── clients/
│   └── telegram-console/            # SVC-TGC: Telegram-бот интерфейс менеджера
│
├── packages/                        # Общие библиотеки (переиспользование)
│   ├── contracts/                   # ← ЕДИНЫЙ ИСТОЧНИК КОНТРАКТОВ (§ 7)
│   │   ├── openapi/                 # OpenAPI-спецификации Backend API
│   │   ├── message-model/           # каноническая модель сообщения (ТЗ §8.4)
│   │   ├── events/                  # схемы WS-событий и внутренних событий/outbox
│   │   └── json-schema/             # схемы структурированных команд AI (ТЗ §12.6)
│   ├── ui-kit/                      # общая React-библиотека компонентов (ТЗ §21.3)
│   ├── api-client/                  # TS-клиент, сгенерированный из OpenAPI
│   └── testing/                     # фабрики данных, фикстуры, тест-утилиты
│
├── db/
│   ├── migrations/                  # миграции схемы (§ 4), владелец — SVC-DATA
│   └── seeds/                       # сиды ролей, демо-организаций
│
├── tests/                           # СКВОЗНЫЕ И МЕЖСЕРВИСНЫЕ ТЕСТЫ
│   ├── contract/                    # контрактные тесты между сервисами (§ 8.4)
│   └── e2e/                         # сценарии ТЗ §26.6 (Playwright + supertest)
│
├── deploy/
│   ├── docker/                      # Dockerfile на каждый сервис (ТЗ §25.9)
│   ├── compose/                     # docker-compose для integration/e2e
│   └── k8s/                         # манифесты/helm (ТЗ §25.8)
│
├── docs/
│   ├── MessengerBridge_TZ.md
│   ├── MessengerBridge_TZ_Review.md
│   └── plan/                        # ← настоящий план
│       ├── README.md                # общий план (этот файл)
│       └── services/                # планы сервисов (§ 11)
│
└── .github/workflows/               # CI: lint → unit → integration → e2e (§ 9)
```

## 3.1 Соглашение о размещении тестов

| Вид теста | Где лежит | Технология | Что проверяет |
|-----------|-----------|------------|----------------|
| **Unit** | рядом с кодом сервиса: `<service>/test/unit` или `*.spec.ts` | Jest (backend), Vitest (frontend) | Изолированные единицы бизнес-логики; без реальных внешних сервисов (ТЗ §26.3). |
| **Integration** | `<service>/test/integration` | Jest + Testcontainers | Взаимодействие с реальной БД/WS и с моками соседних сервисов (ТЗ §26.4). |
| **Contract** | `tests/contract` + артефакты в `packages/contracts` | Pact-подобные | Совместимость «поставщик ↔ потребитель» контракта между сервисами (§ 8.4). |
| **E2E** | `tests/e2e` | Playwright (UI) + supertest (API) + docker-compose | Сквозные сценарии ТЗ §26.6 через все уровни. |

---

# 4. Модель данных (структура БД всех сервисов)

Data Platform (SVC-DATA, план [01](./services/01-data-platform.md)) реализует
**единую БД PostgreSQL 16 + pgvector** (ТЗ §22.2). Доступ к БД имеет **только**
Backend (ТЗ §22.3); вынесенные сервисы работают через Backend API. Ниже —
логическая физическая схема (авторитетная для всех планов). Типы приведены
ориентировочно; окончательная физическая модель — в SVC-DATA.

**Общие правила схемы:**

- `id` — `uuid` (ТЗ §11.9), генерируется приложением; время — `timestamptz` (UTC).
- Каждая арендо-зависимая таблица содержит `organization_id uuid NOT NULL` и
  индексируется по нему (изоляция арендаторов, ТЗ §22.6). Изоляция дополнительно
  усиливается PostgreSQL **Row-Level Security (RLS)** по `organization_id`.
- Идентификаторы-ссылки в истории/аудите — **суррогатные** (не выводимые из ПДн),
  что делает возможным обезличивание вместо удаления (ТЗ §22.11).

## 4.1 Организации, конфигурация, аудит

```sql
organizations(
  id uuid PK, name text, description text, timezone text, locale text,
  status text,                       -- active|blocked (ТЗ §9.3 блокировка)
  created_at timestamptz, updated_at timestamptz)

configurations(
  id uuid PK, organization_id uuid FK, key text, value jsonb,
  version int, updated_by uuid, updated_at timestamptz,
  UNIQUE(organization_id, key))
configuration_history(                -- историчность конфигурации (ТЗ §22.10)
  id uuid PK, organization_id uuid, config_key text, value jsonb,
  version int, changed_by uuid, changed_at timestamptz)

audit_events(                         -- append-only, защита от изменения (ТЗ §23.8)
  id uuid PK, organization_id uuid, actor_user_id uuid, actor_type text, -- user|ai|workflow|system
  action text, object_type text, object_id uuid, result text,
  request_id text, ip inet, metadata jsonb, created_at timestamptz)
```

## 4.2 Identity (SVC-IDN)

```sql
users(
  id uuid PK, organization_id uuid NULL,   -- NULL для Platform Operator (вне организации, ТЗ §9.3)
  telegram_username text, email text, display_name text,
  status text,                              -- active|blocked
  created_at timestamptz, updated_at timestamptz)

roles(id uuid PK, code text UNIQUE, scope text)  -- platform_operator|administrator|manager (ТЗ §9.3)
user_roles(user_id uuid FK, role_id uuid FK, organization_id uuid, PK(user_id, role_id, organization_id))

auth_sessions(
  id uuid PK, user_id uuid FK, organization_id uuid,
  issued_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
  ip inet, user_agent text)                 -- отзыв сессий (ТЗ §9.2, §16.4)

login_codes(                                -- одноразовые коды Telegram-входа (ТЗ §9.5)
  id uuid PK, user_id uuid, code_hash text, purpose text,
  expires_at timestamptz, consumed_at timestamptz)

invitations(                                -- bootstrap организации/пользователей (ТЗ §9.10)
  id uuid PK, organization_id uuid, contact_type text, contact_value text,
  role_id uuid, token_hash text, expires_at timestamptz,
  accepted_at timestamptz, created_by uuid)
```

## 4.3 Клиенты, конечные точки, идентификация (SVC-CORE)

```sql
clients(
  id uuid PK, organization_id uuid, display_name text,
  anonymized_at timestamptz,                -- обезличивание вместо удаления (ТЗ §22.11)
  created_at timestamptz, updated_at timestamptz)

communication_endpoints(
  id uuid PK, organization_id uuid, client_id uuid FK, channel text,  -- telegram|vk|...|web_chat
  external_id text, verified boolean, verified_at timestamptz,
  metadata jsonb, created_at timestamptz,
  UNIQUE(organization_id, channel, external_id))

client_identity_links(                      -- identity resolution / слияние (ТЗ §8.13)
  id uuid PK, organization_id uuid, client_id uuid, endpoint_id uuid,
  link_type text,                           -- verified_phone|verified_email|link_code|manual
  evidence jsonb, created_by uuid, created_at timestamptz, reverted_at timestamptz)

client_notes(id uuid PK, organization_id uuid, client_id uuid, author_id uuid, body text, created_at timestamptz)
client_tags(id uuid PK, organization_id uuid, client_id uuid, tag text)
```

## 4.4 Диалоги, сообщения, вложения (SVC-CORE)

```sql
conversations(
  id uuid PK, organization_id uuid, client_id uuid FK, status text,   -- open|closed|pending
  last_message_at timestamptz, created_at timestamptz,
  INDEX(organization_id, client_id))

messages(
  id uuid PK,                               -- = message_id = сквозной idempotency_key (ТЗ §11.12)
  organization_id uuid, conversation_id uuid FK, endpoint_id uuid FK, channel text,
  direction text,                           -- inbound|outbound
  sender_type text,                         -- client|manager|ai|broadcast|system
  sequence_number bigint,                   -- порядок в рамках Endpoint (ТЗ §7.10)
  type text, content jsonb, status text,    -- received|routed|sent|delivered|failed
  created_at timestamptz, delivered_at timestamptz,
  UNIQUE(id),                               -- дедупликация по сквозному ключу
  INDEX(endpoint_id, sequence_number))      -- восстановление порядка/пропусков

attachments(
  id uuid PK, organization_id uuid, message_id uuid FK, kind text,
  storage_ref text, mime text, size bigint, metadata jsonb)

message_delivery_attempts(                  -- ретраи доставки (ТЗ §10.8, §14.9)
  id uuid PK, message_id uuid FK, adapter text, attempt_no int,
  status text, error text, created_at timestamptz)
```

## 4.5 Каналы и возможности (SVC-INT)

```sql
channels(                                   -- подключённые каналы организации (ТЗ §16.5)
  id uuid PK, organization_id uuid, channel_type text, name text,
  status text,                              -- connected|error|disabled
  credentials_ref text,                     -- ссылка на секрет (ТЗ §23.7), НЕ сам секрет
  config jsonb, last_check_at timestamptz, created_at timestamptz)

adapter_capabilities(                       -- Capability Model (ТЗ §10.6)
  id uuid PK, channel_id uuid FK, capability text, supported boolean)
```

## 4.6 Broadcast (SVC-BCAST)

```sql
broadcasts(
  id uuid PK, organization_id uuid, name text, status text,   -- draft|scheduled|running|done|failed
  template jsonb, filter jsonb, schedule jsonb, rate_limit jsonb,
  created_by uuid, created_at timestamptz)
broadcast_recipients(id uuid PK, broadcast_id uuid FK, client_id uuid, endpoint_id uuid, status text)
broadcast_messages(id uuid PK, broadcast_id uuid FK, message_id uuid FK, status text)  -- связь с messages
broadcast_stats(broadcast_id uuid PK, prepared int, sent int, delivered int, failed int, updated_at timestamptz)
```

## 4.7 Notification (SVC-NOTIF)

```sql
notifications(
  id uuid PK, organization_id uuid, recipient_user_id uuid, category text,  -- info|warning|error|critical|admin
  title text, body text, payload jsonb, status text,           -- new|read
  created_at timestamptz, read_at timestamptz)
notification_settings(
  id uuid PK, organization_id uuid, user_id uuid, category text,
  channel text,                             -- web|telegram|email|push (ТЗ §15.4)
  enabled boolean)
```

## 4.8 Workflow / FBP Engine (SVC-FBP)

```sql
workflows(id uuid PK, organization_id uuid, name text, status text, default_version_id uuid, created_at timestamptz)
workflow_versions(                          -- НЕИЗМЕНЯЕМЫЕ версии (ТЗ §13.10)
  id uuid PK, workflow_id uuid FK, organization_id uuid, version_no int,
  schema jsonb, created_by uuid, created_at timestamptz, UNIQUE(workflow_id, version_no))
workflow_instances(                         -- version pinning (ТЗ §13.10)
  id uuid PK, organization_id uuid, workflow_id uuid, version_id uuid FK,
  status text, started_at timestamptz, finished_at timestamptz)
workflow_instance_state(                    -- состояние вне исполнителя (stateless executor, ТЗ §25.3)
  instance_id uuid PK, state jsonb, updated_at timestamptz)
workflow_execution_logs(                    -- журнал исполнения (ТЗ §13.9, §24.6)
  id uuid PK, organization_id uuid, instance_id uuid FK, node_id text,
  event text, data jsonb, created_at timestamptz)
```

## 4.9 Knowledge Base + pgvector (SVC-API / SVC-AI)

```sql
knowledge_documents(
  id uuid PK, organization_id uuid, title text, source text, status text,  -- indexing|indexed|failed
  indexed_at timestamptz, created_at timestamptz)
knowledge_chunks(
  id uuid PK, organization_id uuid, document_id uuid FK, chunk_no int,
  content text, embedding vector(1536), metadata jsonb)   -- pgvector (ТЗ §12.7, §22.7)
-- индекс: ivfflat/hnsw по embedding; поиск изолирован по organization_id
```

## 4.10 Надёжная интеграция и Edge-буфер

```sql
outbox_events(                              -- транзакционный outbox: ядро → вынесенные сервисы
  id uuid PK, organization_id uuid, aggregate_type text, aggregate_id uuid,
  event_type text, payload jsonb, status text,           -- pending|published|failed
  created_at timestamptz, published_at timestamptz)

edge_message_buffer(                        -- буфер Edge Cluster в RF-контуре (ТЗ §7.9), отдельная БД RF
  id uuid PK, endpoint_id uuid, sequence_number bigint, idempotency_key uuid,
  payload_encrypted bytea, received_at timestamptz, ttl timestamptz, forwarded_at timestamptz)
```

> **Локализация ПДн (ТЗ §7.14, RF-first).** Первичная запись ПДн субъектов РФ
> выполняется в первичной БД в РФ; зарубежный Application Cluster работает с
> вторичной репликой. На уровне схемы это учитывается разделением контуров
> размещения (RF-контур: `edge_message_buffer` и первичная фиксация), а не
> различием структуры таблиц. Детали — в планах SVC-DATA и SVC-EDGE.

## 4.11 Карта «сущность → сервис-владелец»

| Группа таблиц | Владелец схемы | Основной потребитель |
|---|---|---|
| organizations, configurations, audit_events | SVC-DATA/SVC-API | все |
| users, roles, sessions, invitations | SVC-IDN | все (авторизация) |
| clients, endpoints, identity_links, conversations, messages | SVC-CORE | SVC-MWS, SVC-CHAT, SVC-INT |
| channels, adapter_capabilities | SVC-INT | SVC-ADMIN, SVC-CORE |
| broadcasts* | SVC-BCAST | SVC-ADMIN, SVC-MWS |
| notifications* | SVC-NOTIF | SVC-MWS, SVC-TGC |
| workflows* | SVC-FBP | SVC-ADMIN |
| knowledge_* | SVC-API/SVC-AI | SVC-AI |
| outbox_events, edge_message_buffer | SVC-DATA/SVC-EDGE | ядро, Adapters |

---

# 5. Общие вехи (milestones) и дорожная карта

Вехи — общие для всех сервисов синхронизирующие точки. Каждый сервисный план
разбивает свою работу на этапы, привязанные к этим вехам. Веха завершается, когда
выполнен её сквозной сценарий (e2e) и заморожены изменившиеся контракты.

| Веха | Название | Сквозной результат (e2e) | Точки согласования |
|------|----------|--------------------------|--------------------|
| **M0** | Контракты и каркас | Зелёный CI на «скелете»; контракты v1 заморожены; моки контрактов подняты | — (общий старт) |
| **M1** | Вертикальный срез «приём и ответ» | Клиент пишет в Web Chat → менеджер видит и отвечает → клиент получает ответ | CP-1 |
| **M2** | Омниканальность + realtime + AI Assistant | Сообщение из Telegram доходит до менеджера; AI Assistant отвечает из Knowledge Base; realtime по WebSocket | CP-2, CP-3 |
| **M3** | Программируемость | Admin редактирует Workflow в визуальном редакторе; Workflow вызывает Backend API-узел; AI Onboarding применяет конфигурацию; приходят уведомления | CP-4, CP-5 |
| **M4** | Массовые коммуникации + Edge/ПДн | Broadcast-кампания доставлена; трафик РФ идёт через Edge + VPN Tunnel с буферизацией и дедупликацией; Mobile API и Telegram Console работают | CP-6, CP-7, CP-8 |
| **M5** | Стабилизация и приёмка | Полный набор e2e (ТЗ §26.6) зелёный; проверены нагрузка (§25.11), безопасность (§23), RPO/RTO; документация (§28); критерии приёмки (§29) | CP-9 |

## 5.1 Что входит в каждую веху по сервисам (обзор)

| Сервис \ Веха | M0 | M1 | M2 | M3 | M4 | M5 |
|---|---|---|---|---|---|---|
| SVC-DATA | схема v1 + миграции | таблицы M1 | KB/pgvector, identity_links | workflow_* | broadcast_*, edge_buffer, outbox | резервное копирование, историчность |
| SVC-IDN | контракт auth | Telegram-логин, сессии | RBAC guard'ы | аудит действий | bootstrap/приглашения | резервный вход (расширяемость) |
| SVC-CORE | модель сообщения | приём/хранение/маршрут | identity resolution, порядок | события для Workflow | idempotency сквозной, egress | нагрузка/деградация |
| SVC-API | OpenAPI-каркас, ошибки | CRUD клиентов/диалогов | KB API, поиск | фасады AI/FBP | broadcast/notif фасады | версия API, полнота OpenAPI |
| SVC-INT | контракт ingress/egress, Capability | Web Chat adapter | Telegram/Email/SMS/VK/MAX/WA | — | ретраи, rate limit | все каналы, отказоустойчивость |
| SVC-AI | контракт AI | мок | Assistant + KB | Onboarding, структ. команды | — | изоляция, мониторинг |
| SVC-FBP | контракт FBP | мок | — | форк, узел Backend API, Transform | version pinning, stateless | масштабирование |
| SVC-BCAST | контракт broadcast | — | — | планирование | кампании, статистика, ретраи | нагрузка |
| SVC-NOTIF | контракт notif | — | — | доставка, категории | каналы (email/push/telegram) | настройки |
| SVC-EDGE | контракт tunnel | — | WS Gateway (App) | — | Edge + VPN + буфер + порядок | отказоустойчивость Edge |
| SVC-ADMIN | каркас UI | вход, орг-настройки | каналы, KB | редактор Workflow, Onboarding | broadcast, notif настройки | приёмочные сценарии |
| SVC-MWS | каркас UI | очередь, переписка | realtime, AI Assistant UI | — | — | приёмка |
| SVC-CHAT | каркас UI | обмен сообщениями | AI, история | — | Edge-подключение | приёмка |
| SVC-TGC | — | — | — | уведомления, ответ клиенту | AI-подсказки | приёмка |
| SVC-MOB | контракт mobile | — | — | — | эндпоинты, push, sync | версия API |

Подробная разбивка по этапам с задачами, тестами и точками согласования — в
планах сервисов (§ 11).

---

# 6. Точки согласования сервисов (coordination points) и межсервисные тесты

**Точка согласования (CP)** — момент, когда несколько сервисов должны иметь
готовые этапы, чтобы вместе замкнуть сквозной сценарий; в этот момент фиксируется
контракт и **добавляются межсервисные тесты** (contract + e2e). Между CP сервисы
разрабатываются независимо против моков. Каждый сервисный план ссылается на
относящиеся к нему CP.

| CP | Веха | Участники | Что должно быть готово | Замораживаемый контракт | Добавляемые межсервисные тесты |
|----|------|-----------|------------------------|-------------------------|--------------------------------|
| **CP-1** | M1 | SVC-CHAT, SVC-INT(Web Chat), SVC-CORE, SVC-API, SVC-IDN, SVC-MWS, SVC-ADMIN | приём входящего, сохранение, отдача менеджеру, ответ, авторизация | C1 (Message Model), C2 (Ingress/Egress), C3 (Backend REST core), C7 (WS events) | e2e «Web Chat: приём и ответ»; e2e «Авторизация»; e2e «Работа менеджера»; contract INT↔CORE |
| **CP-2** | M2 | SVC-INT(Telegram…), SVC-CORE | входящее из внешнего мессенджера → менеджер → ответ; Capability Model | C2 + C6 (Capability descriptor) | e2e «Telegram: приём и ответ»; contract per-adapter |
| **CP-3** | M2 | SVC-API(AI-Integration), SVC-AI, SVC-DATA(KB), SVC-MWS/CHAT | AI Assistant отвечает из Knowledge Base | C4 (AI request/response, KB search) | e2e «AI Assistant из KB»; contract API↔AI |
| **CP-4** | M3 | SVC-API(FBP-Integration), SVC-FBP | запуск Workflow; узел Backend API вызывает Backend с контекстом пользователя | C5 (FBP start + Backend API node) | e2e «Workflow вызывает Backend API»; contract API↔FBP |
| **CP-5** | M3 | SVC-ADMIN, SVC-FBP, SVC-AI(Onboarding), SVC-API | визуальный редактор Workflow; AI Onboarding применяет конфигурацию | C3 + C4 + C5 (стабилизация) | e2e «Admin правит Workflow»; e2e «AI Onboarding применяет конфиг» |
| **CP-6** | M4 | SVC-BCAST, SVC-CORE, SVC-INT | кампания → сообщения → доставка через единый механизм ядра | C8 (Broadcast), C1/C2 | e2e «Broadcast: доставка кампании» |
| **CP-7** | M4 | SVC-EDGE, SVC-CORE, SVC-CHAT/MOB | трафик РФ через Edge+VPN; буферизация при разрыве; порядок и дедупликация | C9 (Edge↔App tunnel), C1 | e2e «Потеря соединения» (ТЗ §26.6); contract EDGE↔CORE |
| **CP-8** | M4 | SVC-NOTIF, продюсеры (CORE/BCAST/AI/FBP), SVC-MWS, SVC-TGC | уведомление сгенерировано и доставлено в Web и Telegram Console | C10 (Notification) | e2e «Notification в Web + Telegram» |
| **CP-9** | M5 | все | полный набор сценариев ТЗ §26.6, приёмка (§29) | все контракты (v1, заморожены) | полный e2e-набор, регрессия, нагрузочные |

**Статус CP-1 (M1-99, 2026-07-03).** Gate M1 выполнен: добавлен
машинно-читаемый freeze-артефакт `packages/contracts/cp1-freeze.v1.json`,
заморожены C1/C2/C3/C7 как `stable_for_m2`, а сервисные планы M1 для SVC-DATA,
SVC-IDN, SVC-CORE, SVC-API, SVC-INT(Web Chat), SVC-ADMIN, SVC-MWS и SVC-CHAT
помечены завершёнными. Проверки CP-1 покрывают e2e «Web Chat: приём и ответ»,
e2e «Авторизация», e2e «Работа менеджера», contract INT↔CORE и consumer contracts
C3 для SVC-MWS/SVC-ADMIN. Инварианты gate: RLS-изоляция арендаторов,
идемпотентный `POST /messages`, переходы статусов `received -> routed -> sent` и
аудит изменяющих операций. Готовность M2: стабильные C1/C2/C3/C7; следующий scope
M2 — adapters, realtime, AI Assistant, identity resolution.

**Статус CP-2/CP-3 (M2-99, 2026-07-03).** Gate M2 выполнен: добавлен
машинно-читаемый freeze-артефакт `packages/contracts/cp2-cp3-freeze.v1.json`,
заморожены C2/C6/C4 как `stable_for_m3`. Проверки CP-2 покрывают e2e
«Telegram: приём и ответ» и per-adapter contract INT↔CORE для Telegram, Email,
SMS, VK, MAX и WhatsApp: каждый adapter потребляет C2 Ingress и публикует C6
Capability Descriptor. Проверки CP-3 покрывают e2e «AI Assistant из KB»,
consumer contract API↔AI и реальный pgvector/RLS-путь KB-поиска через
Testcontainers. Инварианты gate: маршрутизация по capabilities, а не по имени
канала; изоляция KB-поиска по `organization_id`; порядок по `sequence_number` в
рамках endpoint; C7 realtime/reconnect без дублей; деградация AI с валидным C4
fallback без остановки переписки. Готовность M3: стабильные C2/C6/C4; следующий
scope M3 — outbox/domain events, FBP/Workflow, AI Onboarding, Notification и
фасады `ai-integration`/`fbp-integration` с circuit breaker.

**Статус CP-4/CP-5 (M3-99, 2026-07-03).** Gate M3 выполнен: расширен
машинно-читаемый freeze-артефакт `packages/contracts/cp4-cp5-freeze.v1.json`,
на CP-4 заморожен C5 (запуск Workflow + узел Backend API), а на CP-5 совместно
стабилизированы C3/C4/C5 как `stable_for_m4`. Проверки CP-4 покрывают e2e
«Workflow вызывает Backend API», contract API↔FBP, idempotent replay outbox и
аудит `actor_type = workflow`. Проверки CP-5 покрывают e2e «Admin правит
Workflow» и «AI Onboarding применяет конфиг», contract API↔AI и повторную
валидацию структурированной команды §12.6 на Backend. Инварианты gate: Backend
API — единственный санкционированный способ изменения данных из Workflow/AI;
права проверяются по реальному принципалу; Transform Node валидируется на
сохранении схемы; Workflow изолирован по `organization_id`; `workflow_*` и
outbox готовы как стабильная база M4. Готовность M4: стабильные C3/C4/C5,
`outbox_events`, `workflow_*`; следующий scope M4 — сквозная идемпотентность,
Broadcast CP-6, Edge/VPN/буфер CP-7, Notification CP-8, Mobile API, Telegram
Console и фасады broadcast/notification.

**Статус CP-6/CP-7/CP-8 (M4-99, 2026-07-04).** Интеграционный gate M4 выполнен:
на CP-6 заморожен C8 (Broadcast) в сопряжении с C1/C2, на CP-7 — C9 (Edge↔App
tunnel) в сопряжении с C1, на CP-8 — C10 (Notification) и схема C7-события
`notification.created`. Машинно-читаемые freeze-артефакты:
`packages/contracts/cp6-cp7-freeze.v1.json` (C1/C2/C8/C9 как `stable_for_m5`) и
`packages/contracts/cp8-freeze.v1.json` (C10 и `notification.created` как
`stable_for_m5`); оба скреплены gate-тестом
`tests/contract/m4-gate-freeze.test.ts`. Проверки CP-6 покрывают e2e «Broadcast:
доставка кампании» и contract BCAST↔CORE (`backend-dist-communication-core.test.ts`,
`broadcast-delivery-cp6.test.ts`, `c8-broadcast-contract.test.ts`,
`int-delivery-attempts-cp6.test.ts`). Проверки CP-7 покрывают e2e «Потеря
соединения» и contract EDGE↔CORE (`mobile-connection-loss-cp7.test.ts`,
`edge-core-c9-c7.contract.test.ts`).
Проверки CP-8 покрывают e2e «Notification в Web + Telegram» и contract
«продюсеры↔NOTIF» и NOTIF↔MWS/TGC (`c10-notification-contract.test.ts`,
`manager-workspace-c10-consumer.test.ts`, `telegram-console-cp8-consumer.test.ts`).
Сквозные инварианты gate: сквозной `idempotency_key = message_id` на всех
переходах (клиент→Edge→буфер→Core→Adapter) без дублей; восстановление порядка по
`(endpoint_id, sequence_number)` в рамках Endpoint; доставка кампаний и
уведомлений только через единый механизм ядра (C1/C2 для Broadcast,
единственный владелец `notification.created` — SVC-NOTIF); RF-first размещение
ПДн (буфер Edge в БД РФ-контура); RLS-изоляция арендаторов по `organization_id`;
доставка уведомления учитывает подписки на каналы (отключённый канал не
доставляется). Готовность M5: стабильные C1/C2/C8/C9/C10 и
`notification.created`, данные `messages`, `message_delivery_attempts`,
`broadcast_messages`, `edge_message_buffer`, `notifications`; следующий scope
M5 — нагрузка/деградация, отказоустойчивость Edge и RPO/RTO, полнота
OpenAPI/версионирование, тонкие настройки уведомлений и приёмка CP-9.

**Статус CP-9 (M5-99, 2026-07-04).** Интеграционный gate M5 выполнен: полный
e2e-набор ТЗ §26.6 (11 сценариев: «Авторизация», «Работа менеджера», «Web Chat»,
«Telegram», «AI Assistant из KB», «Workflow вызывает Backend API», «AI Onboarding
применяет конфиг», «Notification в Web + Telegram», «Broadcast: доставка
кампании», «Edge Cluster», «Потеря соединения») прогоняется зелёной регрессией;
нагрузочные пробники (ядро, API, BCAST, FBP, EDGE(WS), MOB) и деградация
проверены (§25.2/§25.3/§25.11); security review §23 пройден (RLS по всем
ресурсам, валидация Transform Node, секреты только по ссылке и ротация,
append-only аудит, обезличивание ПДн, отзыв сессий); RPO/RTO подтверждены пробным
backup/restore SVC-DATA и авто-синхронизацией буфера SVC-EDGE; OpenAPI полон и
версионирование без дрейфа (`/api/v1` стабилен, ломающее — только `/api/v2`;
мобильный контракт `MOBILE.v1 = 1.1.0` версионируется независимо, §19.6).
Финальная заморозка: машинно-читаемый артефакт
`packages/contracts/cp9-freeze.v1.json` помечает все контракты
(C1/C2/C3.auth/C3.base/C4/C5/C6/C7 + `notification.created`/C8/C9/C10/MOBILE.v1)
как `released_v1`; артефакт скреплён gate-тестом
`tests/contract/m5-gate-freeze.test.ts` и консолидирует все предыдущие freeze
CP-1…CP-8 и приёмку SVC-API (CP-9). Приёмочный отчёт §29 и результаты сведены в
`docs/operations/m5-acceptance-gate.md` и `docs/operations/m5-security-review.md`.
Дальнейшие ломающие изменения — только новой версией URL/semver и новым CP
(§7.4/§9.3); `released_v1` не мутируется. Все критерии приёмки §29 выполнены —
платформа принята к релизу v1.

## 6.1 Граф зависимостей вех (упрощённо)

```text
M0 (контракты) ──► M1 (INT·CORE·API·IDN·MWS) ──► M2 (+AI·KB, +адаптеры, realtime)
                                                     │
                                                     ▼
                                   M3 (+FBP·редактор·Onboarding·NOTIF)
                                                     │
                                                     ▼
                            M4 (+BCAST, +EDGE·VPN·буфер, +MOB·TGC)
                                                     │
                                                     ▼
                                        M5 (приёмка §29)
```

---

# 7. Каталог контрактов и API (интерфейсы всех сервисов)

Контракты хранятся в `packages/contracts` и являются **общими артефактами**.
Ниже — каталог; детальные схемы каждого контракта ведёт сервис-владелец в своём
плане. Все REST-эндпоинты — под префиксом версии `/api/v1` (ТЗ §11.8), формат
JSON/UUID/ISO-8601 (ТЗ §11.9), единый формат ошибок (ТЗ §11.11).

## 7.1 Внутренние контракты (между сервисами)

| ID | Контракт | Направление | Владелец | Назначение |
|----|----------|-------------|----------|------------|
| **C1** | Message Model | общий | SVC-CORE | Каноническая модель сообщения (ТЗ §8.4): поля §4.4; используется всеми. |
| **C2** | Ingress/Egress | INT ↔ CORE | SVC-CORE | `POST /internal/ingress/messages` (Adapter→Core, приём) и delivery-контракт Core→Adapter (отправка). |
| **C4** | AI Contract | API ↔ AI | SVC-AI | Запрос/ответ ассистента, структурированная команда (ТЗ §12.6), поиск по KB. |
| **C5** | FBP Contract | API ↔ FBP | SVC-FBP | Запуск Workflow, обратный вызов узла Backend API (ТЗ §13.5). |
| **C6** | Capability Descriptor | INT → CORE | SVC-INT | Публикация возможностей канала (ТЗ §10.6). |
| **C7** | WS Events | Backend → клиенты | SVC-CORE/API | События реального времени (ТЗ §11.7). |
| **C9** | Edge↔App Tunnel | EDGE ↔ CORE | SVC-EDGE | Передача сообщений с `sequence_number` и `idempotency_key` (ТЗ §7.10, §11.12). |
| **C-OUT** | Outbox/Events | ядро → вынесенные | SVC-DATA | Транзакционный outbox для надёжной асинхронной интеграции. |

## 7.2 Публичный REST API (Backend API, ТЗ §11) — обзор по группам

| Группа | Основные эндпоинты (v1) | Сервис |
|--------|-------------------------|--------|
| **C3.auth** | `POST /auth/login/telegram/start`, `POST /auth/login/telegram/verify`, `POST /auth/logout`, `GET /auth/session` | SVC-IDN |
| **C3.platform** | `POST /platform/organizations`, `POST /platform/organizations/{id}/administrators`, `POST /platform/organizations/{id}/block` | SVC-IDN/API |
| **C3.org** | `GET/PATCH /organizations/{id}`, `GET/PUT /organizations/{id}/configuration` | SVC-API |
| **C3.users** | `GET/POST /organizations/{id}/users`, `PATCH /users/{id}`, `POST /users/{id}/sessions:revoke`, `POST /invitations` | SVC-IDN/API |
| **C3.clients** | `GET/POST /clients`, `GET /clients/{id}`, `POST /clients/{id}/endpoints`, `POST /clients:merge`, `POST /clients/{id}/notes`, `POST /clients/{id}/tags` | SVC-CORE/API |
| **C3.conversations** | `GET /conversations`, `GET /conversations/{id}`, `GET /conversations/{id}/messages` | SVC-CORE |
| **C3.messages** | `POST /messages` (идемпотентно, ТЗ §11.12), `GET /messages/{id}` | SVC-CORE |
| **C3.channels** | `GET/POST /channels`, `POST /channels/{id}:test`, `GET /channels/{id}/capabilities` | SVC-INT/API |
| **C3.kb** | `GET/POST /knowledge/documents`, `POST /knowledge/documents/{id}:reindex`, `POST /knowledge:search` (internal для AI) | SVC-API |
| **C3.ai** | `POST /ai/assistant:suggest`, `POST /ai/onboarding:command` | SVC-AI |
| **C3.workflows** | `GET/POST /workflows`, `POST /workflows/{id}/versions`, `POST /workflows/{id}/instances`, `GET /workflows/{id}/instances/{iid}` | SVC-FBP |
| **C8.broadcasts** | `GET/POST /broadcasts`, `POST /broadcasts/{id}:start`, `GET /broadcasts/{id}/stats` | SVC-BCAST |
| **C10.notifications** | `GET /notifications`, `POST /notifications/{id}:read`, `GET/PUT /notifications/settings` | SVC-NOTIF |
| **C7.ws** | `GET /ws` (WebSocket upgrade); события — §7.3 | SVC-CORE/EDGE |
| **health** | `GET /health`, `GET /metrics` (на каждом сервисе, ТЗ §24.4) | все |

Полные списки эндпоинтов с методами, DTO, кодами ответов и правами доступа —
в планах сервисов-владельцев.

## 7.3 События WebSocket (C7, ТЗ §11.7)

`message.created`, `message.status_changed`, `typing.started`, `typing.stopped`,
`client.status_changed`, `notification.created`, `broadcast.state_changed`,
`workflow.state_changed`. Общий envelope C7 v1 содержит `event_id`,
`organization_id`, `sequence_number`, `payload`, `occurred_at`; endpoint
`GET /ws` выполняет WebSocket upgrade. Соединение восстанавливается автоматически
через resume cursor `last_event_id`: клиент отбрасывает уже виденные `event_id`,
а сервер досылает события после указанного cursor без повторной доставки уже
подтверждённой клиентом части потока (ТЗ §11.7).

## 7.4 Правила версионирования и совместимости

- Версия в URL (`/api/v1`), ломающие изменения — только новая версия (ТЗ §11.8).
- Mobile API версионируется независимо (ТЗ §19.6).
- OpenAPI генерируется из кода и является частью поставки (ТЗ §11.14).

---

# 8. Стратегия тестирования (unit / integration / e2e / contract)

Соответствует ТЗ §26. Разработка без автотестов не допускается (ТЗ §26.1).

## 8.1 Пирамида тестов

1. **Unit** (ТЗ §26.3) — сервисы, обработчики сообщений, валидаторы,
   преобразователи, авторизация, сервисы AI, Workflow Adapter. Без внешних
   сервисов (моки). Быстрые, запускаются на каждый коммит.
2. **Integration** (ТЗ §26.4) — обязательные связки: Backend↔PostgreSQL,
   Backend↔Communication Core, Backend↔AI Platform, Backend↔FBP Engine,
   Backend↔Integration Platform, Backend↔WebSocket. Реальная БД через
   Testcontainers; соседние вынесенные сервисы — через контрактные моки.
3. **Contract** (§ 8.4) — на каждой точке согласования; предотвращают дрейф
   контрактов между «поставщиком» и «потребителем».
4. **E2E** (ТЗ §26.5–§26.6) — сквозные сценарии через все уровни.

## 8.2 Обязательные E2E-сценарии (ТЗ §26.6) → веха

| Сценарий (ТЗ §26.6) | Веха | Ведущие сервисы |
|---|---|---|
| Авторизация (Telegram-вход) | M1 | SVC-IDN, SVC-ADMIN/MWS |
| Работа менеджера (очередь, история, ответ) | M1 | SVC-MWS, SVC-CORE |
| Web Chat (новая Conversation, обмен) | M1 | SVC-CHAT, SVC-CORE |
| Telegram (приём→менеджер→ответ→доставка) | M2 | SVC-INT, SVC-CORE |
| AI Assistant (запрос→KB→ответ) | M2 | SVC-AI, SVC-API |
| Workflow (запуск→Node→завершение→журнал) | M3 | SVC-FBP, SVC-API |
| AI Onboarding (команда→Backend API→конфиг) | M3 | SVC-AI, SVC-ADMIN |
| Notification (генерация→Web + Telegram Console) | M3 | SVC-NOTIF, SVC-MWS, SVC-TGC |
| Broadcast (кампания→получатели→доставка) | M4 | SVC-BCAST, SVC-CORE |
| Edge Cluster (РФ→VPN Tunnel→обработка) | M4 | SVC-EDGE, SVC-CORE |
| Потеря соединения (буфер→восстановление→без потерь/дублей, порядок) | M4 | SVC-EDGE, SVC-CORE |

## 8.3 Целевые показатели покрытия

- Ядро (SVC-IDN/CORE/API): unit-покрытие критической логики ≥ 80 %.
- Каждый публичный эндпоинт — минимум один integration-тест (счастливый путь +
  проверка изоляции арендатора + ошибка валидации).
- Каждый CP — минимум один contract-тест и один e2e-тест.
- Регрессия E2E запускается на каждый PR в ядро и на ночных сборках (ТЗ §26.7).

## 8.4 Контрактное тестирование

Для пар «потребитель ↔ поставщик» (INT↔CORE, API↔AI, API↔FBP, EDGE↔CORE,
продюсеры↔NOTIF) применяются consumer-driven contracts: потребитель публикует
ожидания, поставщик верифицирует их в своём CI. Артефакты — в
`packages/contracts`. Это позволяет менять сервисы независимо, ловя
несовместимость до e2e.

---

# 9. CI/CD, окружения и Definition of Done

## 9.1 Конвейер CI (`.github/workflows`)

```text
lint (ESLint/Prettier, ТЗ §27.5)
  └─► unit (Jest/Vitest, все сервисы, параллельно)
        └─► build + docker (по сервисам, ТЗ §25.9)
              └─► integration (Testcontainers: PostgreSQL+pgvector)
                    └─► contract (верификация контрактов)
                          └─► e2e (docker-compose up всех сервисов; сценарии M-вехи)
```

- Каждый сервис имеет независимый `Dockerfile` (ТЗ §25.9) и health-check (ТЗ §24.4).
- Ночью — полный e2e-набор + нагрузочные пробники (ориентиры ТЗ §25.11).

## 9.2 Окружения

`local` (docker-compose) → `ci` → `staging` (k8s) → `prod` (App Cluster + Edge RF).
Конфигурация — только через внешние переменные окружения (ТЗ §25.10); секреты —
через централизованный менеджер секретов (ТЗ §23.7).

## 9.3 Управление контрактами

Изменение контракта требует: (1) PR в `packages/contracts`, (2) согласования
сервисов-участников соответствующего CP, (3) semver-версии. Ломающее изменение —
только в новой версии API (ТЗ §11.8).

## 9.4 Definition of Done этапа (единый для всех сервисов)

Этап считается завершённым, когда:

1. Реализована функциональность этапа и её публичные интерфейсы задокументированы
   (OpenAPI/схемы обновлены, ТЗ §11.14).
2. Есть unit-тесты (ТЗ §26.3) и integration-тесты для затронутых связок (ТЗ §26.4).
3. Соблюдена изоляция арендаторов (ТЗ §22.6) и серверная валидация (ТЗ §11.10).
4. Для этапов на точке согласования — добавлены contract- и e2e-тесты (§ 6).
5. Зелёный CI (lint→unit→integration→contract→e2e для затронутых сценариев).
6. Действия, изменяющие критические объекты, пишут аудит (ТЗ §22.9, §23.8).
7. Обновлён план сервиса (отметка о завершении этапа) и, при изменении сквозных
   решений, — настоящий мастер-план.

---

# 10. Управление рисками и зависимостями

| Риск | Влияние | Митигирование (где в плане) |
|------|---------|------------------------------|
| Дрейф контрактов при параллельной разработке | Ломает интеграцию на CP | Contract-first (M0), contract-тесты (§ 8.4), заморозка на CP (§ 6) |
| FBP Engine — значительный форк, а не «настройка» (ревью §4.9) | Срыв вехи M3 | Отдельный этап переработки в плане SVC-FBP; мок FBP до CP-4 |
| Порядок vs масштабирование vs ретраи (ТЗ §7.10) | Дубли/перестановки сообщений | Партиционирование по Endpoint + `sequence_number` + сквозной `idempotency_key`; e2e «Потеря соединения» (CP-7) |
| Data-residency 152-ФЗ (ТЗ §7.14) | Юридический риск | RF-first в SVC-DATA/SVC-EDGE; первичная запись в РФ; обезличивание (ТЗ §22.11) |
| Монолит как единая точка отказа модулей | Нарушение «Communication First» | Вынос деградируемых сервисов (§ 2), таймауты/circuit breaker в фасадах (ТЗ §11.2) |
| Application Cluster — SPOF (ревью §2.3) | Простой платформы | multi-AZ/реплики/RPO-RTO в вехе M5 (ТЗ §7.12, §25.11) |
| Безопасность Transform Node / произвольный код | Уязвимость мультиарендной SaaS | Декларативный safe-evaluator (ТЗ §13.4) в SVC-FBP |

## 10.1 Критический путь

`SVC-DATA (схема) → SVC-CORE (модель сообщения, приём) → CP-1 (M1)` — это
критический путь: пока не готов вертикальный срез M1, зависимые вехи не
стартуют полноценно. Поэтому SVC-DATA и SVC-CORE начинают первыми в M0/M1;
остальные сервисы в это время работают против моков контрактов.

---

# 11. Навигация по планам сервисов

Первая серия параллельных задач для старта разработки (веха M0) вынесена в
отдельный документ:
[parallel-stage-1-prompts.md](./parallel-stage-1-prompts.md).

Вторая серия параллельных задач для вертикального среза «приём и ответ» (веха
M1, точка согласования CP-1) — в документе
[parallel-stage-2-prompts.md](./parallel-stage-2-prompts.md).

Третья серия параллельных задач для омниканальности, realtime и AI Assistant (веха
M2, точки согласования CP-2 и CP-3) — в документе
[parallel-stage-3-prompts.md](./parallel-stage-3-prompts.md).

Четвёртая серия параллельных задач для программируемости — Workflow, узел Backend
API и AI Onboarding (веха M3, точки согласования CP-4 и CP-5) — в документе
[parallel-stage-4-prompts.md](./parallel-stage-4-prompts.md).

Пятая серия параллельных задач для массовых коммуникаций, Edge/ПДн и уведомлений —
Broadcast через ядро, Edge + VPN Tunnel и Notification в Web/Telegram (веха M4,
точки согласования CP-6, CP-7 и CP-8) — в документе
[parallel-stage-5-prompts.md](./parallel-stage-5-prompts.md).

Шестая серия параллельных задач для стабилизации и приёмки — полный e2e-набор
(§ 26.6), нагрузка/деградация (§ 25.11), безопасность (§ 23), RPO/RTO,
документация (§ 28) и критерии приёмки (§ 29) с финальной заморозкой всех
контрактов v1 (веха M5, точка согласования CP-9) — в документе
[parallel-stage-6-prompts.md](./parallel-stage-6-prompts.md).

| Сервис | План | Точки согласования |
|--------|------|--------------------|
| Data Platform | [01-data-platform.md](./services/01-data-platform.md) | все (поставщик схемы) |
| Identity Platform | [02-identity-platform.md](./services/02-identity-platform.md) | CP-1 |
| Communication Core | [03-communication-core.md](./services/03-communication-core.md) | CP-1, CP-2, CP-6, CP-7 |
| Backend API и домены | [04-backend-api.md](./services/04-backend-api.md) | CP-1, CP-3, CP-4, CP-5 |
| Integration Platform | [05-integration-platform.md](./services/05-integration-platform.md) | CP-1, CP-2, CP-6 |
| AI Platform | [06-ai-platform.md](./services/06-ai-platform.md) | CP-3, CP-5 |
| FBP Engine | [07-fbp-engine.md](./services/07-fbp-engine.md) | CP-4, CP-5 |
| Broadcast Platform | [08-broadcast-platform.md](./services/08-broadcast-platform.md) | CP-6 |
| Notification Platform | [09-notification-platform.md](./services/09-notification-platform.md) | CP-8 |
| Edge & WebSocket Gateway | [10-edge-websocket-gateway.md](./services/10-edge-websocket-gateway.md) | CP-7 |
| SaaS Administration | [11-saas-administration.md](./services/11-saas-administration.md) | CP-5 |
| Manager Workspace | [12-manager-workspace.md](./services/12-manager-workspace.md) | CP-1, CP-3, CP-8 |
| Web Chat | [13-web-chat.md](./services/13-web-chat.md) | CP-1, CP-3, CP-7 |
| Telegram Console | [14-telegram-console.md](./services/14-telegram-console.md) | CP-8 |
| Mobile API | [15-mobile-api.md](./services/15-mobile-api.md) | CP-7 |

---

*Документ является планом и подлежит актуализации по мере развития проекта и
изменения технического задания. При расхождении с ТЗ приоритет имеет ТЗ
([`docs/MessengerBridge_TZ.md`](../MessengerBridge_TZ.md)).*
