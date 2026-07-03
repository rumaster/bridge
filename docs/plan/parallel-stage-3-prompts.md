---
title: Третья серия промптов для параллельного выполнения этапа M2
subtitle: Последовательность третьего этапа и набор задач для омниканальности, realtime и AI Assistant (CP-2, CP-3)
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/README.md (v1.0)
---

# Третья серия промптов для параллельного выполнения этапа M2

Документ отвечает на issue #63: анализирует план, фиксирует порядок выполнения и
даёт третью серию промптов для параллельного прохождения третьего этапа. Он
продолжает первую серию
[`parallel-stage-1-prompts.md`](./parallel-stage-1-prompts.md) (этап M0) и вторую
серию [`parallel-stage-2-prompts.md`](./parallel-stage-2-prompts.md) (этап M1).

Под «третьим этапом» здесь понимается **M2 — Омниканальность + realtime + AI
Assistant** из [`docs/plan/README.md`](./README.md): сообщение из внешнего
мессенджера (Telegram и др.) доходит до менеджера и возвращается ответом; AI
Assistant отвечает из Knowledge Base; обновления идут в realtime по WebSocket.
Этап замыкается на **двух** точках согласования: **CP-2** — омниканальность
(SVC-INT(Telegram…) + SVC-CORE, заморозка **C2 + C6** Capability descriptor, e2e
«Telegram: приём и ответ») и **CP-3** — AI Assistant из Knowledge Base
(SVC-API(AI-Integration) + SVC-AI + SVC-DATA(KB) + SVC-MWS/CHAT, заморозка **C4**,
e2e «AI Assistant из KB»). M2 опирается на результаты M1: контракты **C1/C2/C3/C7**
заморожены на CP-1, живой срез «приём и ответ» работает, поэтому команды продолжают
работать независимо и сходятся только на CP-2 и CP-3.

---

# 1. Итоговая последовательность выполнения

## 1.1 Общая последовательность вех

1. **M0 — Контракты и каркас.** *(выполнено первой серией.)* Структура репозитория,
   CI-скелет, контракты v1, моки и базовые приложения/сервисы.
2. **M1 — Вертикальный срез «приём и ответ».** *(выполнено второй серией.)* Web Chat
   → Core → Manager Workspace → ответ клиенту; точка согласования **CP-1**.
3. **M2 — Омниканальность + realtime + AI Assistant.** *(текущий этап.)* Внешние
   адаптеры, WebSocket realtime, AI Assistant из Knowledge Base; **CP-2**, **CP-3**.
4. **M3 — Программируемость.** FBP, визуальный редактор Workflow, AI Onboarding,
   Notification; **CP-4**, **CP-5**.
5. **M4 — Broadcast + Edge/ПДн + Mobile/Telegram Console.** Массовые коммуникации,
   RF Edge, буферизация, Mobile API, Telegram Console; **CP-6**, **CP-7**,
   **CP-8**.
6. **M5 — Стабилизация и приёмка.** Полный e2e-набор, нагрузка, безопасность,
   RPO/RTO, документация; **CP-9**.

Критический путь третьего этапа (§ 10.1 мастер-плана, две ветки к CP-2 и CP-3):

```text
M1 contracts C1/C2/C3/C7 (заморожены на CP-1)
  -> SVC-DATA M2 schema (KB/pgvector, identity_links, channels/capabilities)
  -> ветка CP-2: SVC-CORE(identity/order/realtime) + SVC-INT(адаптеры + C6)
  -> ветка CP-3: SVC-API(KB API) + SVC-AI(RAG) + SVC-DATA(KB)
  -> realtime-транспорт: SVC-EDGE(WS Gateway) + фронтенды (MWS/CHAT/ADMIN)
```

## 1.2 Внутренний порядок M2

M2 лучше выполнять в три шага:

1. **M2-01, короткий обязательный предшественник.** SVC-DATA создаёт схему M2
   (§ 4.3/M2 мастер-плана, раздел 5.3 плана SVC-DATA): `knowledge_documents`/
   `knowledge_chunks` с `vector(1536)` и индексом **ivfflat/hnsw**,
   `client_identity_links`, `channels`/`adapter_capabilities`, `client_notes`/
   `client_tags`, с изоляцией векторного поиска по `organization_id`. Без реальной
   схемы integration-тесты ядра (pgvector-поиск, identity links, каналы) не
   проходят — это единственный жёсткий предшественник M2.
2. **M2-02...M2-13, параллельная волна.** Владельцы сервисов реализуют
   M2-функциональность в своих зонах, потребляя схему SVC-DATA и **замороженные на
   CP-1** контракты C1/C2/C3/C7. Волна распадается на две сходящиеся ветки:
   - **CP-2 (омниканальность):** SVC-CORE (identity resolution, порядок,
     публикация C7) и SVC-INT (адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp +
     наполнение Capability Model C6).
   - **CP-3 (AI Assistant из KB):** SVC-API (Knowledge Base API, C3.kb) и SVC-AI
     (пайплайн RAG поверх KB-поиска, C4).
   - **Realtime и клиенты:** SVC-EDGE (WebSocket Gateway на стороне Application
     Cluster) — транспорт C7; SVC-MWS, SVC-CHAT, SVC-ADMIN потребляют realtime и
     новые разделы. SVC-IDN добавляет полноценный RBAC. Бэкенд-модули ядра (CORE,
     API, IDN) работают против реальной схемы SVC-DATA; фронтенды и внешние
     адаптеры — против моков публичного API/WS, пока живые срезы не собраны на
     gate.
3. **M2-99, интеграционный gate CP-2 + CP-3.** Проверка, что оба среза замыкаются
   сквозными сценариями: e2e «Telegram: приём и ответ» (CP-2) и «AI Assistant из
   KB» (CP-3); заморозка **C2 + C6** на CP-2 и **C4** на CP-3; добавление
   per-adapter contract-тестов INT↔CORE и contract API↔AI; подтверждение realtime
   по WebSocket без дублей после reconnect.

## 1.3 Сервисы без задач на M2

По матрице § 5.1 мастер-плана на M2 **не ведут крупных работ**: SVC-FBP (остаётся
**мок** из M0), SVC-BCAST, SVC-NOTIF, SVC-TGC и SVC-MOB (строки «—»). Их моки/
каркасы из M0 сохраняются без изменений и поддерживаются регрессией CI. Отдельных
промптов в третьей серии для них нет; они подключаются позднее — на M3+ и своих
точках согласования (CP-4…CP-8). Поэтому в этой серии используются номера активных
на M2 сервисов **01–09** и **13** (SVC-EDGE, который на M1 не имел задач, а на M2
поднимает WebSocket Gateway); номера **10, 11, 12, 14, 15** (SVC-FBP, SVC-BCAST,
SVC-NOTIF, SVC-MOB, SVC-TGC) в этой серии не используются. Нумерация задач
сохраняет сквозное соответствие сервису из первой серии.

---

# 2. Правила для исполнителей третьей серии

- Каждый исполнитель берёт **ровно один** промпт из раздела 4.
- Формулировка задачи должна звучать как: «Выполнить этап **M2** плана
  `docs/plan/services/XX-...md`».
- Реализуется **только** объём M2 своего сервиса; нельзя забегать в вехи M3+
  (outbox/доменные события, Workflow/FBP, AI Onboarding, Notification, Broadcast,
  Edge-контур РФ, hardened-фасады с circuit breaker) сверх того, что нужно для
  прохождения CP-2 и CP-3.
- Между CP разработка идёт против **моков** соседних контрактов, замороженных на
  CP-1 (C1/C2/C3/C7). Бэкенд-модули ядра для своих integration-тестов используют
  **реальную схему** SVC-DATA (результат M2-01), включая **pgvector** через
  Testcontainers.
- Контрактные артефакты и их обновления кладутся в `packages/contracts`; код
  сервиса — только в его директорию из мастер-плана § 3.
- Соблюдаются сквозные инварианты: изоляция арендаторов по `organization_id` (RLS,
  ТЗ §22.6) — в том числе **изоляция KB-поиска** (чужие org не попадают в выдачу);
  серверная валидация (ТЗ §11.10); идемпотентность по
  `idempotency_key = message_id` (ТЗ §11.12); секреты каналов — только как
  `credentials_ref`/хеши, не сами значения (ТЗ §23.7); авторитетная авторизация на
  Backend (RBAC, ТЗ §9.8).
- Для каждого промпта результатом должны быть код/миграции/документация, тесты
  (unit + integration, а на CP-2/CP-3 — contract + e2e) и короткий отчёт: что
  сделано, какие команды проверки запущены, какие контракты затронуты.

---

# 3. Критерии готовности M2

M2 считается завершённой, когда:

- SVC-DATA создал схему M2 (`knowledge_documents`/`knowledge_chunks` с
  `vector(1536)` и индексом ivfflat/hnsw, `client_identity_links`, `channels`/
  `adapter_capabilities`, `client_notes`/`client_tags`), миграции обратимы
  (`up`/`down`), а изоляция векторного поиска по арендатору подтверждена тестом;
- SVC-CORE выполняет identity resolution/слияние (ТЗ §8.13) с аудитом и
  обратимостью, присваивает `sequence_number` (single-writer на партицию,
  обнаружение пропусков) и публикует C7-события (`message.created`,
  `message.status_changed`, `typing.*`, `client.status_changed`) в realtime;
- SVC-INT предоставляет адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp, нормализующие
  вход/исход в C1, и **наполненную Capability Model (C6)** по каждому каналу; ядро
  маршрутизирует по возможностям канала (ТЗ §10.6), а не по имени;
- SVC-API отдаёт Knowledge Base API (`C3.kb`: документы, статус индексации,
  reindex, internal `POST /knowledge:search`) с изоляцией поиска по арендатору;
- SVC-AI отвечает из Knowledge Base пайплайном RAG (эмбеддинг запроса → KB-поиск
  через Backend → генерация ответа с цитированием источников), со сменяемой
  абстракцией LLM (детерминированный мок в тестах) и деградацией при недоступности
  LLM; заморожен **C4**;
- SVC-EDGE поднял WebSocket Gateway на стороне Application Cluster (`GET /ws`,
  удержание соединений, доставка C7, горизонтальное масштабирование, reconnect без
  дублей) — без Edge-контура РФ (он на M4);
- SVC-MWS показывает realtime (сообщения/статусы/typing) с авто-reconnect без
  дублей/пропусков и панель AI-подсказок (`POST /ai/assistant:suggest`, C4) с
  деградацией;
- SVC-CHAT показывает AI-ответы в ленте, полную историю с подгрузкой и realtime по
  WS (C7) с авто-reconnect;
- SVC-ADMIN даёт разделы «Каналы связи» (C3.channels: статусы/возможности/тест
  подключения, realtime-статус по C7) и «Knowledge Base» (C3.kb: загрузка/
  обновление/удаление документов, reindex, индикатор индексации);
- SVC-IDN обеспечивает полноценный RBAC по ролям (§9.3): `RolesGuard` + `@Roles()`,
  снят mock-guard, проверки 403;
- на CP-2 заморожены **C2 + C6** и добавлены per-adapter contract-тесты INT↔CORE и
  e2e «Telegram: приём и ответ»; на CP-3 заморожен **C4**, добавлен contract API↔AI
  и e2e «AI Assistant из KB»;
- CI зелёный: lint → unit → integration (в т.ч. pgvector через Testcontainers) →
  contract → e2e затронутых сценариев (§ 9.4 мастер-плана).

---

# 4. Третья серия промптов

## M2-01 — SVC-DATA: pgvector, Knowledge Base, identity links, каналы

```text
Выполни этап M2 плана docs/plan/services/01-data-platform.md.

Цель: дать ядру и AI полную схему M2 — Knowledge Base на pgvector для AI Assistant
(CP-3) и таблицы омниканальности/связывания клиентов для identity resolution
(CP-2), с изоляцией векторного поиска по арендатору.

Исходные документы:
- docs/plan/README.md, разделы 4.3 M2, 5, 6 CP-2/CP-3, 9, 10.1;
- docs/plan/services/01-data-platform.md, раздел 5.3 M2.

Зона ответственности:
- db/migrations;
- db/seeds;
- тестовые фикстуры БД в packages/testing или сервисной test-директории.

Сделай:
1. Создай knowledge_documents и knowledge_chunks с колонкой vector(1536) и
   индексом ivfflat/hnsw; предусмотри статус индексации документа.
2. Создай client_identity_links с аудитом и обратимостью (reverted_at) для
   ручного/автоматического слияния клиентов (ТЗ §8.13, §23.8).
3. Создай channels и adapter_capabilities для омниканальности и Capability Model;
   секреты канала храни как credentials_ref, не сам токен (ТЗ §23.7).
4. Создай client_notes и client_tags.
5. Обеспечь изоляцию векторного поиска по organization_id (RLS + фильтр): ближайшие
   соседи возвращаются только в пределах своей организации.
6. Проверь миграции по циклу up -> down -> up на реальной БД с расширением
   pgvector.

Проверка:
- unit: фабрики документов/чанков и эмбеддингов (детерминированные векторы);
- integration: миграции up/down; pgvector-поиск (ближайшие соседи в пределах одной
  организации, чужие org не попадают в выдачу — RLS + фильтр); credentials_ref
  вместо секрета.

Не делай:
- не создавай таблицы M3+ (workflow_*, broadcast_*, notifications, outbox_events,
  edge_message_buffer) сверх пустых forward-compatible заглушек, если они нужны и
  явно помечены как неиспользуемые;
- не переноси в БД бизнес-логику RAG/identity — она в ядре и SVC-AI.
```

## M2-02 — SVC-CORE: identity resolution, порядок, realtime (C7)

```text
Выполни этап M2 плана docs/plan/services/03-communication-core.md.

Цель: сделать историю омниканальной и упорядоченной, а обновления — realtime:
слияние клиентов по верифицированным идентификаторам, гарантия порядка по Endpoint
и публикация событий C7. Ядро — участник CP-2.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.3, 8.2, 6 CP-2;
- docs/plan/services/03-communication-core.md, раздел M2 и CP-2 (M2).

Зона ответственности:
- services/backend/src/modules/communication-core;
- потребление схемы SVC-DATA (client_identity_links, sequence_number,
  channels/adapter_capabilities) через backend;
- contract tests/contract для per-adapter INT<->CORE.

Сделай:
1. Реализуй identity resolution/слияние (ТЗ §8.13): поведение по умолчанию для
   неизвестного/анонимного Endpoint; автосвязывание только по верифицированному
   идентификатору (verified_phone/verified_email/link_code); ручное объединение с
   аудитом (ТЗ §23.8) и обратимостью (client_identity_links.reverted_at); слияние
   историй по времени и sequence_number.
2. Реализуй порядок по Endpoint (ТЗ §7.10): присвоение sequence_number,
   single-writer на партицию, обнаружение пропусков.
3. Реализуй маршрутизацию по возможностям канала (Capability Model C6, ТЗ §10.6),
   а не по имени канала.
4. Реализуй публикацию C7-событий в realtime: message.created,
   message.status_changed, typing.*, client.status_changed.

Проверка:
- unit: назначение sequence_number, логика слияния/«разслияния» клиентов,
  дедупликация по idempotency_key;
- integration: Backend<->PostgreSQL (порядок, links), Backend<->WebSocket
  (ТЗ §26.4);
- contract: per-adapter INT<->CORE (потребитель C2 — адаптеры — верифицируются);
- e2e: «Telegram: приём и ответ» (CP-2).

Не делай:
- не реализуй транзакционный outbox и доменные события для Workflow — это M3;
- не реализуй сквозную идемпотентность через Edge-буфер, интеграцию Broadcast и
  приём от SVC-EDGE(C9) — это M4;
- WebSocket-транспорт (удержание соединений) держит SVC-EDGE; ядро только
  публикует события.
```

## M2-03 — SVC-IDN: полноценный RBAC по ролям

```text
Выполни этап M2 плана docs/plan/services/02-identity-platform.md.

Цель: перейти от базового AuthGuard (M1) к полноценному RBAC по ролям (§9.3):
серверная авторизация действий по ролям как единственный авторитетный контур.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.2, 5.1 (строка SVC-IDN);
- docs/plan/services/02-identity-platform.md, раздел M2.

Зона ответственности:
- services/backend/src/modules/identity;
- общий RolesGuard и декоратор @Roles() для backend-модулей;
- packages/contracts/openapi/auth (актуализация при необходимости).

Сделай:
1. Реализуй RolesGuard и декоратор @Roles() поверх сессий и ролей пользователя
   (роли из user_roles, ТЗ §9.3, §9.8).
2. Замени mock-guard из M0/M1 на реальную проверку ролей; закрой действия
   доменных эндпоинтов требуемыми ролями.
3. Обеспечь корректные 403 при недостатке прав и 401 при отсутствии сессии.

Проверка:
- unit: матрица «роль -> разрешённое/запрещённое действие», отказ по недостатку
  прав, наследование/комбинации ролей;
- integration: Backend<->PostgreSQL для ролей; защищённые эндпоинты возвращают 403
  без нужной роли и 200 с ней; изоляция арендаторов.

Не делай:
- не реализуй self-service bootstrap организаций и приглашения — это M4;
- не реализуй аудит действий как отдельную крупную подсистему сверх нужного для
  RBAC — интеграция аудита AI/Workflow идёт в M3 (SVC-API);
- проверки прав не дублируй в UI как авторитетные — UI даёт только UX-подсказки.
```

## M2-04 — SVC-API: Knowledge Base API (C3.kb)

```text
Выполни этап M2 плана docs/plan/services/04-backend-api.md.

Цель: дать REST для Knowledge Base — CRUD документов, статус индексации, reindex и
internal-поиск для AI; стабилизировать C3.kb для CP-3.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.2, 9, 6 CP-3;
- docs/plan/services/04-backend-api.md, раздел M2 и CP-3 (M2/M3).

Зона ответственности:
- services/backend/src/modules Knowledge Base API;
- packages/contracts/openapi/backend-core (актуализация C3.kb);
- взаимодействие с SVC-AI по наполнению knowledge_chunks (контракт через мок).

Сделай:
1. GET/POST /knowledge/documents, удаление/обновление, статус индексации
   (ТЗ §16.6).
2. POST /knowledge/documents/{id}:reindex — постановка переиндексации
   (взаимодействие с SVC-AI по наполнению knowledge_chunks).
3. POST /knowledge:search — internal семантический поиск для AI с изоляцией по
   organization_id (ТЗ §12.7, §22.7).
4. Запись audit_events для изменяющих операций над документами (ТЗ §22.9).

Проверка:
- unit: валидаторы документов, маппинг статусов индексации;
- integration: Backend<->PostgreSQL (документы, изоляция арендатора); Backend<->AI
  по контракту KB-search через мок (мастер §8.1, ТЗ §26.4) — 3 случая;
- e2e: участие в «AI Assistant из KB» (мастер §8.2, CP-3).

Не делай:
- не реализуй фасад ai-integration (POST /ai/assistant:suggest) с timeout/circuit
  breaker/bulkhead и фасад fbp-integration — это M3;
- не реализуй broadcast/notification фасады — это M4;
- поиск KB строго internal и изолирован по арендатору; чужие документы в выдачу не
  попадают.
```

## M2-05 — SVC-INT: адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp и Capability Model

```text
Выполни этап M2 плана docs/plan/services/05-integration-platform.md.

Цель: сделать платформу омниканальной — адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp,
нормализующие вход/исход в C1 через C2, с наполненной Capability Model (C6) по
каждому каналу. SVC-INT — участник CP-2.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.2, 6 CP-2, 8.4;
- docs/plan/services/05-integration-platform.md, раздел 5.3 M2 и CP-2 (M2).

Зона ответственности:
- services/integration-platform/src/adapters/{telegram,email,sms,vk,max,whatsapp};
- packages/contracts для C6 (Capability descriptor) по каждому каналу;
- contract/integration per-adapter INT<->CORE.

Сделай:
1. Реализуй адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp: нормализацию входящего в
   C1 и Ingress (C2), доставку ответа (C2 Egress) по каждому каналу; внешние API —
   через моки в тестах.
2. Наполни Capability Model (C6) по каждому каналу по факту поддержки (текст,
   вложения, typing_indicator, read_receipt и пр., ТЗ §10.6).
3. Доведи C3.channels: POST /channels/{id}:test (проверка подключения),
   GET /channels/{id}/capabilities.
4. Секреты каналов храни как credentials_ref, не сами токены (ТЗ §23.7); сохраняй
   сквозной idempotency_key (= message_id) при доставке.

Проверка:
- unit: нормализация вход/исход по каждому каналу в C1 и маппинг возможностей;
- integration: Backend<->Integration (ТЗ §26.4) — приём -> Ingress -> ядро; ответ
  -> Egress -> доставка (мок канала);
- contract: per-adapter consumer-driven INT<->CORE (каждый адаптер — потребитель C2
  и поставщик C6);
- e2e: CP-2 «Telegram: приём и ответ».

Не делай:
- не реализуй ретраи/бэкофф, rate limiting и идемпотентную массовую доставку — это
  M4;
- не подключай Edge-контур РФ и буфер при разрыве — это M4;
- C6 наполняется по реальным возможностям канала, а не заглушкой «всё поддержано».
```

## M2-06 — SVC-CHAT: AI-ответы, полная история, realtime по WS (C7)

```text
Выполни этап M2 плана docs/plan/services/13-web-chat.md.

Цель: довести клиентскую сторону до M2 — AI-ответы в ленте, полная история с
подгрузкой и realtime по WebSocket (C7) с авто-reconnect.

Исходные документы:
- docs/plan/README.md, разделы 3, 6 CP-3, 7.2, 8.2;
- docs/plan/services/13-web-chat.md, раздел 5.3 M2.

Зона ответственности:
- apps/web-chat;
- потребление публичного чат-API и WS (C7) — реальные или MSW-моки;
- переиспользование packages/ui-kit.

Сделай:
1. Отобрази AI-ответы в ленте через стандартный механизм ядра (AI-ответ приходит
   как обычное сообщение).
2. Реализуй полную историю с пагинацией/бесконечной подгрузкой
   (GET /conversations/{id}/messages).
3. Реализуй realtime по WS (C7): message.created, message.status_changed,
   typing.*; авто-reconnect соединения после разрыва без дублей/пропусков (дедуп по
   message.id, докрутка по sequence_number).

Проверка:
- unit: рендер AI-ответа и статусов, дедупликация событий по message.id,
  восстановление после reconnect;
- integration: против мок-Backend/WS (MSW) или dev-стенда — подгрузка истории,
  realtime-обновления, reconnect без дублей;
- e2e: участие в realtime-сценариях M2.

Не делай:
- не реализуй подключение клиентов РФ через Edge и буфер/дедуп при разрыве
  Edge-туннеля — это M4;
- WS-транспорт держит SVC-EDGE; клиент только подписывается и обрабатывает события;
- не дублируй компоненты — переиспользуй packages/ui-kit (ТЗ §21.3).
```

## M2-07 — SVC-MWS: realtime по WS и панель AI-подсказок (CP-3)

```text
Выполни этап M2 плана docs/plan/services/12-manager-workspace.md.

Цель: дать менеджеру realtime и AI-подсказки — живые сообщения/статусы/typing по WS
с авто-reconnect и панель AI-подсказок поверх C4. SVC-MWS — участник CP-3.

Исходные документы:
- docs/plan/README.md, разделы 3, 6 CP-3, 7.2, 8.2;
- docs/plan/services/12-manager-workspace.md, раздел M2 и CP-3 (M2).

Зона ответственности:
- apps/manager-workspace;
- потребление WS (C7) и ai-integration (C4) — реальные или MSW-моки;
- consumer-driven contract-тесты потребителя C7/C4.

Сделай:
1. Реализуй WS-клиент (C7): live сообщения/статусы/typing.*; авто-reconnect без
   дублей/пропусков (дедуп по message.id, докрутка по sequence_number).
2. Реализуй панель AI-подсказок: POST /ai/assistant:suggest (C4) с отображением
   ответа и источников; graceful degradation при недоступности AI (переписка
   продолжается).
3. Замени polling/refetch из M1 на realtime там, где это уместно.

Проверка:
- unit: обработка WS-событий, дедупликация, рендер панели AI-подсказок и
  деградации;
- integration: против MSW-моков C7/C4 — realtime-обновления и запрос подсказки;
- e2e: участие в «AI Assistant из KB» (веб-часть, CP-3) и в realtime-сценариях M2.

Не делай:
- не реализуй интерфейс уведомлений — это M3;
- проверки прав не веди в UI как авторитетные — RBAC на Backend (SVC-IDN, ТЗ §9.8);
- WS-транспорт держит SVC-EDGE; workspace только подписывается на события.
```

## M2-08 — SVC-ADMIN: разделы «Каналы связи» и «Knowledge Base»

```text
Выполни этап M2 плана docs/plan/services/11-saas-administration.md.

Цель: дать администратору управление каналами связи (C3.channels) и Knowledge Base
(C3.kb) с realtime-статусами каналов по WS (C7).

Исходные документы:
- docs/plan/README.md, разделы 3, 7.2, 8.2, 6 CP-2/CP-3;
- docs/plan/services/11-saas-administration.md, раздел M2.

Зона ответственности:
- apps/saas-admin;
- потребление C3.channels, C3.kb и WS (C7) — реальные или MSW-моки;
- Playwright-сценарии разделов каналов и KB.

Сделай:
1. Раздел «Каналы связи» (C3.channels): список со статусом/возможностями/журналом
   ошибок, тест подключения (POST /channels/{id}:test), realtime-статус канала по
   WS (C7); секреты вводятся и хранятся как credentials_ref.
2. Раздел «Knowledge Base» (C3.kb): загрузка/обновление/удаление документов,
   постановка reindex, индикатор статуса индексации.

Проверка:
- unit: формы канала и документа, отображение статусов/ошибок валидации, индикатор
  индексации;
- integration (MSW): управление каналом и документом против мок-Backend;
  realtime-обновление статуса канала;
- e2e (Playwright): сценарии «Каналы связи» и «Knowledge Base».

Не делай:
- не реализуй визуальный редактор Workflow и AI Onboarding — это M3;
- не реализуй Broadcast и настройки Notification — это M4;
- секреты канала не показывай и не храни как значения — только credentials_ref
  (ТЗ §23.7).
```

## M2-09 — SVC-AI: AI Assistant, пайплайн RAG (CP-3)

```text
Выполни этап M2 плана docs/plan/services/06-ai-platform.md.

Цель: рабочий AI Assistant, отвечающий из Knowledge Base — основа e2e «AI Assistant
из KB». SVC-AI — участник CP-3; на нём замораживается C4.

Исходные документы:
- docs/plan/README.md, разделы 7.2 C4, 8.2, 6 CP-3;
- docs/plan/services/06-ai-platform.md, раздел M2 и CP-3 (M2).

Зона ответственности:
- services/ai-platform;
- packages/contracts для C4 (AI request/response, KB search);
- contract/integration Backend<->AI.

Сделай:
1. Реализуй пайплайн RAG: эмбеддинг запроса (через абстракцию LLM) -> KB-поиск
   через Backend (POST /knowledge:search, C3.kb) с изоляцией по organization_id ->
   генерация ответа с цитированием источников (ссылки на использованные
   knowledge_chunks/документы) (ТЗ §12.3, §12.7).
2. Реализуй сменяемую абстракцию LLM для генерации/эмбеддингов (ТЗ §12.9); в тестах
   — детерминированный мок.
3. Обеспечь изоляцию по арендатору в промпте и контексте (только документы своей
   организации, ТЗ §22.6).
4. Реализуй POST /ai/assistant:suggest поверх пайплайна с деградацией (заглушка при
   недоступности LLM, ТЗ §5.4).

Проверка:
- unit: сборка промпта (только санкционированный контекст, изоляция Tenant);
  ранжирование результатов RAG на моке эмбеддингов (порядок по близости);
  формирование источников/цитирования;
- integration: Backend<->AI Platform (ТЗ §26.4) через мок LLM и реальный
  pgvector-поиск (Testcontainers, мастер §8.1); изоляция арендатора в KB-поиске;
- contract: верификация C4 (потребитель — SVC-API/ai-integration, CP-3);
- e2e: «AI Assistant из KB» (запрос -> KB -> ответ с источниками, CP-3).

Не делай:
- не реализуй AI Onboarding (структурированные команды) — это M3;
- LLM-провайдер подключается через абстракцию; в тестах — только детерминированный
  мок;
- KB-поиск идёт через Backend (C3.kb); прямого доступа AI к БД KB не делай.
```

## M2-13 — SVC-EDGE: WebSocket Gateway на стороне Application Cluster

```text
Выполни этап M2 плана docs/plan/services/10-edge-websocket-gateway.md.

Цель: обеспечить realtime-транспорт M2 — доставку событий C7 клиентам и менеджерам
по WebSocket на стороне Application Cluster, без Edge-контура РФ (он на M4).

Исходные документы:
- docs/plan/README.md, разделы 7.3 C7, 8.2, 5.1 (строка SVC-EDGE);
- docs/plan/services/10-edge-websocket-gateway.md, раздел M2.

Зона ответственности:
- services/edge-websocket-gateway;
- packages/contracts для C7 (WS events) — потребление, транспорт;
- integration Backend<->WebSocket.

Сделай:
1. Реализуй WebSocket Gateway: GET /ws (upgrade), удержание соединений.
2. Реализуй доставку событий C7 (message.created, message.status_changed, typing.*,
   client.status_changed, notification.* и др., ТЗ §11.7) в нужные соединения.
3. Обеспечь горизонтальное масштабирование WS (ТЗ §25.3).
4. Реализуй авто-reconnect соединения после разрыва без дублирующей доставки
   (ТЗ §11.7).

Проверка:
- unit: маршрутизация события в нужное соединение, логика переподключения без
  дублей;
- integration: Backend<->WebSocket (ТЗ §26.4);
- e2e: участие в realtime-сценариях M2 (омниканальность/AI Assistant — доставка
  обновлений в UI менеджера/клиента).

Не делай:
- не реализуй Edge Cluster в РФ, VPN Tunnel, буфер и первичную фиксацию ПДн — это
  основная работа M4;
- события в realtime формирует и публикует SVC-CORE; шлюз только транспортирует их
  без дублей.
```

## M2-99 — Интеграционный gate M2 (CP-2 + CP-3)

```text
Выполни интеграционный gate CP-2 и CP-3 для завершения M2 после выполнения
M2-01...M2-09 и M2-13.

Цель: убедиться, что омниканальный срез и AI-срез замыкаются сквозными сценариями,
и заморозить C2 + C6 на CP-2 и C4 на CP-3.

Исходные документы:
- docs/plan/README.md, разделы 5, 6 CP-2/CP-3, 7, 8.2, 9;
- docs/plan/services/{01,02,03,04,05,06,10,11,12,13}-*.md, только разделы M2.

Зона ответственности:
- tests/e2e для сценариев M2;
- tests/contract для per-adapter INT<->CORE и API<->AI;
- packages/contracts (заморозка версий C2 + C6 и C4);
- CI jobs; docs/plan status notes, если нужно.

Сделай:
1. Собери и прогони e2e «Telegram: приём и ответ» (CP-2) на связке
   SVC-INT(Telegram) + SVC-CORE + SVC-API + SVC-EDGE + SVC-MWS.
2. Собери и прогони e2e «AI Assistant из KB» (CP-3) на связке SVC-AI + SVC-API(KB)
   + SVC-DATA(KB) + SVC-MWS/SVC-CHAT.
3. Добавь и проверь per-adapter contract-тесты INT<->CORE (потребитель C2,
   поставщик C6) и contract API<->AI (потребитель C4).
4. Проверь сквозные инварианты M2: маршрутизация по возможностям канала (не по
   имени), изоляция KB-поиска по арендатору, порядок по sequence_number, realtime
   по WS без дублей после reconnect, деградация при недоступности AI.
5. Зафиксируй заморозку C2 + C6 на CP-2 и C4 на CP-3; отметь в планах сервисов
   завершение этапа M2.
6. Сформируй список готовности к M3: что стабильно (C2/C6/C4) и что входит в M3
   (outbox/доменные события, FBP/Workflow, AI Onboarding, Notification, фасады
   ai-integration/fbp-integration с circuit breaker).

Проверка:
- workspace lint/test/build;
- integration (в т.ч. pgvector через Testcontainers) + contract + e2e затронутых
  сценариев (§ 9.4);
- если есть docker-compose стенд, подними связку M2 и прогони оба среза end-to-end.

Не делай:
- не переписывай чужие сервисные реализации крупными правками; если найден
  конфликт контрактов или ownership, зафиксируй его как blocker и предложи
  минимальный patch;
- не забегай в M3 (outbox, Workflow/FBP, AI Onboarding, Notification, hardened-
  фасады) сверх фиксации границ.
```

---

# 5. Что запускать первым

Минимальный практичный запуск M2:

1. Выполнить **M2-01** (SVC-DATA) — обязательный предшественник: без реальной схемы
   M2 (KB/pgvector, identity_links, каналы) integration-тесты ядра и AI не проходят.
2. Как только схема готова, параллельно запустить две сходящиеся ветки и realtime:
   - **CP-2 (омниканальность):** **M2-02** (CORE: identity/порядок/C7) и **M2-05**
     (INT: адаптеры + C6).
   - **CP-3 (AI из KB):** **M2-04** (API: KB API) и **M2-09** (AI: RAG-пайплайн).
   - **Realtime и клиенты:** **M2-13** (EDGE: WS Gateway), **M2-07** (MWS),
     **M2-06** (CHAT), **M2-08** (ADMIN), **M2-03** (IDN: RBAC). Бэкенд-модули
     (CORE/API/IDN) идут против реальной схемы SVC-DATA (включая pgvector через
     Testcontainers); фронтенды и внешние адаптеры — против моков C1/C2/C3/C7 до
     сборки живых срезов.
3. Сервисы без задач на M2 (SVC-FBP — мок из M0; SVC-BCAST, SVC-NOTIF, SVC-TGC,
   SVC-MOB — «—») не запускать: их артефакты M0 сохраняются под регрессией.
4. После слияния результатов выполнить **M2-99** (gate CP-2 + CP-3) и только затем
   открывать серию M3-промптов для CP-4/CP-5.
