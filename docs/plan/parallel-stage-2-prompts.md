---
title: Вторая серия промптов для параллельного выполнения этапа M1
subtitle: Последовательность второго этапа и набор задач для вертикального среза «приём и ответ» (CP-1)
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/README.md (v1.0)
---

# Вторая серия промптов для параллельного выполнения этапа M1

Документ отвечает на issue #41: анализирует план, фиксирует порядок выполнения и
даёт вторую серию промптов для параллельного прохождения второго этапа. Он
продолжает первую серию
[`parallel-stage-1-prompts.md`](./parallel-stage-1-prompts.md) (этап M0).

Под «вторым этапом» здесь понимается **M1 — Вертикальный срез «приём и ответ»** из
[`docs/plan/README.md`](./README.md): клиент пишет в Web Chat → сообщение проходит
через ядро → менеджер видит и отвечает → клиент получает ответ. Этап замыкается на
точке согласования **CP-1**, где на живом срезе замораживаются контракты **C1**
(Message Model), **C2** (Ingress/Egress), **C3** (Backend REST core) и **C7** (WS
events). M1 опирается на результаты M0: контракты v1 и моки уже заморожены, CI-скелет
и каркасы сервисов подняты, поэтому команды продолжают работать независимо и сходятся
только на CP-1.

---

# 1. Итоговая последовательность выполнения

## 1.1 Общая последовательность вех

1. **M0 — Контракты и каркас.** *(выполнено первой серией.)* Структура репозитория,
   CI-скелет, контракты v1, моки и базовые приложения/сервисы.
2. **M1 — Вертикальный срез «приём и ответ».** *(текущий этап.)* Web Chat → Core →
   Manager Workspace → ответ клиенту; точка согласования **CP-1**.
3. **M2 — Омниканальность + realtime + AI Assistant.** Внешние адаптеры,
   WebSocket realtime, AI Assistant из Knowledge Base; **CP-2**, **CP-3**.
4. **M3 — Программируемость.** FBP, визуальный редактор Workflow, AI Onboarding,
   Notification; **CP-4**, **CP-5**.
5. **M4 — Broadcast + Edge/ПДн + Mobile/Telegram Console.** Массовые коммуникации,
   RF Edge, буферизация, Mobile API, Telegram Console; **CP-6**, **CP-7**,
   **CP-8**.
6. **M5 — Стабилизация и приёмка.** Полный e2e-набор, нагрузка, безопасность,
   RPO/RTO, документация; **CP-9**.

Критический путь до первого работающего сценария (§ 10.1 мастер-плана):

```text
M0 contracts/mocks (выполнено)
  -> SVC-DATA M1 schema (базовые таблицы среза)
  -> SVC-CORE M1 ingress/storage/routing
  -> CP-1: SVC-CHAT + SVC-INT(Web Chat) + SVC-API + SVC-IDN + SVC-MWS
```

## 1.2 Внутренний порядок M1

M1 лучше выполнять в три шага:

1. **M1-01, короткий обязательный предшественник.** SVC-DATA создаёт базовые
   таблицы вертикального среза (§ 4.2/M1 мастер-плана) с инвариантами `messages`
   (`UNIQUE(id)`, `INDEX(endpoint_id, sequence_number)`), полным RLS и
   append-only `audit_events`/`configuration_history`. Без реальной схемы
   integration-тесты SVC-CORE/SVC-IDN/SVC-API (`Backend↔PostgreSQL`) не проходят —
   это единственный жёсткий предшественник M1.
2. **M1-02...M1-08, параллельная волна.** Владельцы сервисов реализуют
   M1-функциональность в своих зонах, потребляя схему SVC-DATA и **замороженные на
   M0 моки** C1/C2/C3/C7. Бэкенд-модули ядра (CORE, IDN, API) работают против
   реальной схемы SVC-DATA; фронтенды (CHAT, MWS, ADMIN) и адаптер Web Chat (INT)
   — против моков публичного API/WS, пока живой срез не собран на gate.
3. **M1-99, интеграционный gate CP-1.** Проверка, что срез замыкается сквозным
   сценарием: e2e «Web Chat: приём и ответ», «Авторизация», «Работа менеджера»;
   заморозка C1/C2/C3/C7 на живом примере; добавление contract-теста INT↔CORE.

## 1.3 Сервисы без задач на M1

По матрице § 5.1 мастер-плана на M1 **не ведут крупных работ**: SVC-AI (остаётся
**мок** из M0), SVC-FBP (остаётся **мок** из M0), SVC-BCAST, SVC-NOTIF, SVC-EDGE,
SVC-TGC и SVC-MOB (строки «—»). Их моки/каркасы из M0 сохраняются без изменений и
поддерживаются регрессией CI. Отдельных промптов во второй серии для них нет; они
подключаются позднее — на M2+ и своих точках согласования (CP-2…CP-8). Поэтому
номера задач второй серии совпадают с первой только для активных на M1 сервисов
(01–08); номера 09–15 в этой серии не используются.

---

# 2. Правила для исполнителей второй серии

- Каждый исполнитель берёт **ровно один** промпт из раздела 4.
- Формулировка задачи должна звучать как: «Выполнить этап **M1** плана
  `docs/plan/services/XX-...md`».
- Реализуется **только** объём M1 своего сервиса; нельзя забегать в вехи M2+
  (realtime по WS, AI-ответы, внешние адаптеры, identity resolution, Workflow,
  Broadcast, Notification, Edge) сверх того, что нужно для прохождения CP-1.
- Между CP разработка идёт против **моков** соседних контрактов, замороженных на
  M0. Бэкенд-модули ядра для своих integration-тестов используют **реальную схему**
  SVC-DATA (результат M1-01).
- Контрактные артефакты и их обновления кладутся в `packages/contracts`; код
  сервиса — только в его директорию из мастер-плана § 3.
- Соблюдаются сквозные инварианты: изоляция арендаторов по `organization_id` (RLS,
  ТЗ §22.6), серверная валидация (ТЗ §11.10), идемпотентность по
  `idempotency_key = message_id` (ТЗ §11.12), секреты — только как `*_ref`/хеши, не
  сами значения (ТЗ §23.7).
- Для каждого промпта результатом должны быть код/миграции/документация, тесты
  (unit + integration, а на CP-1 — contract + e2e) и короткий отчёт: что сделано,
  какие команды проверки запущены, какие контракты затронуты.

---

# 3. Критерии готовности M1

M1 считается завершённой, когда:

- созданы все базовые таблицы среза (§ 4.2/M1), миграции обратимы (`up`/`down`), а
  RLS-изоляция двух арендаторов подтверждена тестом;
- SVC-CORE принимает входящее через C2 Ingress, сохраняет `messages`/`attachments`,
  формирует/находит Conversation, маршрутизирует менеджеру и отдаёт ответ через
  минимальный Egress; статусы проходят `received → routed → sent`;
- SVC-IDN обеспечивает Telegram-вход по одноразовому коду и серверные сессии с
  базовым `AuthGuard`; заморожен **C3.auth**;
- SVC-API отдаёт доменные CRUD (organization, configuration, clients, users-фасад) и
  проксирует `conversations`/`messages` в ядро; заморожен **C3** (base);
- SVC-INT предоставляет реальный **Web Chat Adapter** (нормализация в C1, Ingress,
  Egress) и публикует **C6** Web Chat;
- SVC-CHAT обменивается сообщениями через ядро (сессия, отправка идемпотентно,
  приём ответа, статус, базовая история);
- SVC-MWS даёт менеджеру цикл «очередь → история → ответ» (realtime не обязателен,
  допустим polling/refetch до M2);
- SVC-ADMIN обеспечивает вход и управление организацией/конфигурацией;
- на CP-1 добавлены contract-тест INT↔CORE и e2e «Web Chat: приём и ответ»,
  «Авторизация», «Работа менеджера»; заморожены **C1/C2/C3/C7**;
- CI зелёный: lint → unit → integration → contract → e2e затронутых сценариев
  (§ 9.4 мастер-плана).

---

# 4. Вторая серия промптов

## M1-01 — SVC-DATA: базовые таблицы вертикального среза

```text
Выполни этап M1 плана docs/plan/services/01-data-platform.md.

Цель: дать ядру полную схему для сквозного сценария «приём и ответ» (CP-1) —
клиенты, конечные точки, диалоги, сообщения, вложения и попытки доставки, с
инвариантами идемпотентности и порядка, полным RLS и append-only аудитом.

Исходные документы:
- docs/plan/README.md, разделы 4.1-4.4, 4.11, 5, 6 CP-1, 9, 10.1;
- docs/plan/services/01-data-platform.md, раздел 5.2 M1.

Зона ответственности:
- db/migrations;
- db/seeds;
- тестовые фикстуры БД в packages/testing или сервисной test-директории.

Сделай:
1. Создай все таблицы § 4.2/M1: organizations, configurations,
   configuration_history, audit_events, users, roles, user_roles, auth_sessions,
   login_codes, invitations, clients, communication_endpoints, conversations,
   messages, attachments, message_delivery_attempts.
2. Выстави инварианты messages: UNIQUE(id) как идемпотентный ключ,
   INDEX(endpoint_id, sequence_number) для восстановления порядка; уникальность
   endpoint и конфигурации.
3. Доведи RLS по organization_id до полного покрытия арендо-зависимых таблиц.
4. Включи append-only запись audit_events и configuration_history.
5. Проверь миграции по циклу up -> down -> up на реальной БД.

Проверка:
- unit: валидаторы и фабрики для messages/clients/conversations;
- integration: миграции up/down; RLS-изоляция двух арендаторов (данные org A не
  видны под контекстом org B); дедупликация по idempotency_key (вставка дубля id
  отклоняется); восстановление порядка по (endpoint_id, sequence_number).

Не делай:
- не создавай таблицы M2+ (KB/pgvector, identity_links, каналы, workflow,
  broadcast, notification, outbox, edge_buffer) сверх пустых forward-compatible
  заглушек, если они нужны и явно помечены как неиспользуемые;
- не переноси в БД бизнес-логику — она в ядре (SVC-CORE/API).
```

## M1-02 — SVC-CORE: Ingress/Egress, хранение и маршрутизация

```text
Выполни этап M1 плана docs/plan/services/03-communication-core.md.

Цель: замкнуть ядро вертикального среза — принять входящее, сохранить, сформировать
Conversation, отдать менеджеру и отправить ответ на доставку (Communication First).

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.2, 7.3, 8.2, 6 CP-1;
- docs/plan/services/03-communication-core.md, раздел M1.

Зона ответственности:
- services/backend/src/modules/communication-core;
- потребление схемы SVC-DATA (messages/conversations/attachments/
  message_delivery_attempts) через backend;
- contract tests/contract для INT<->CORE.

Сделай:
1. Реализуй Ingress (C2): приём входящего, проверку (ТЗ §8.3), регистрацию и
   сохранение messages/attachments.
2. Реализуй создание/поиск Conversation (ТЗ §8.5) со status и last_message_at и
   маршрутизацию менеджеру (ТЗ §8.6).
3. Реализуй GET /conversations, GET /conversations/{id}/messages, POST /messages
   (идемпотентно по idempotency_key).
4. Реализуй минимальный Egress: ответ менеджера -> SVC-INT; базовую запись
   message_delivery_attempts.
5. Зафиксируй конечный автомат статусов received -> routed -> sent.

Проверка:
- unit: переходы status (received->routed->sent), формирование Conversation;
- integration: Backend<->PostgreSQL (сохранение, изоляция арендатора),
  Backend<->Communication Core (ТЗ §26.4);
- contract: INT<->CORE (потребитель C2 — SVC-INT — верифицируется).

Не делай:
- не реализуй identity resolution/слияние клиентов, назначение sequence_number с
  single-writer на партицию и обнаружением пропусков — это M2;
- не реализуй WS realtime (публикацию событий C7) и outbox — это M2/M3;
- Egress только для Web Chat через мок SVC-INT; внешних адаптеров не подключай.
```

## M1-03 — SVC-IDN: Telegram-логин, сессии, базовый guard

```text
Выполни этап M1 плана docs/plan/services/02-identity-platform.md.

Цель: рабочий вход по одноразовому коду Telegram и серверные сессии — фундамент для
e2e «Авторизация» и «Работа менеджера»; заморозка C3.auth на CP-1.

Исходные документы:
- docs/plan/README.md, разделы 7.2 C3.auth, 8.2, 6 CP-1;
- docs/plan/services/02-identity-platform.md, раздел M1.

Зона ответственности:
- services/backend/src/modules/identity;
- packages/contracts/openapi/auth (актуализация C3.auth до заморозки);
- общий AuthGuard для backend-модулей.

Сделай:
1. POST /auth/login/telegram/start: поиск пользователя по telegram_username,
   генерация одноразового кода, сохранение code_hash с TTL, запрос доставки через
   мок адаптера (ТЗ §9.5).
2. POST /auth/login/telegram/verify: проверка кода (не истёк, не использован),
   пометка consumed_at, выпуск auth_sessions с expires_at.
3. POST /auth/logout (revoked_at) и GET /auth/session.
4. Базовый AuthGuard: активная, не истёкшая и не отозванная сессия + принадлежность
   организации (ТЗ §9.8).
5. Seeded-организация и seeded-admin для e2e; сид ролей. Защита от перебора: лимит
   попыток/локаут и rate limit на start/verify (ТЗ §23.5).

Проверка:
- unit: генерация/проверка/истечение кода, одноразовость (consumed_at), TTL сессии,
  отказ по истёкшей/отозванной сессии;
- integration: Backend<->PostgreSQL для login_codes/auth_sessions; изоляция
  арендаторов;
- contract: верификация C3.auth (CP-1);
- e2e: участие в «Авторизация» и во входе сценария «Работа менеджера».

Не делай:
- не реализуй полный RBAC/RolesGuard по всем ролям — это M2;
- не реализуй self-service bootstrap организаций и приглашения — это M4;
- не реализуй резервный email-вход (вне MVP, ТЗ §9.6) — только точки расширения;
- в БД храни только code_hash/token_hash, не сами секреты (ТЗ §23.7).
```

## M1-04 — SVC-API: доменные CRUD и проксирование ядра

```text
Выполни этап M1 плана docs/plan/services/04-backend-api.md.

Цель: базовый REST для сквозного среза — доменные CRUD (организация, конфигурация,
клиенты, пользователи) и отдача Conversation/Message через каркас; заморозка C3
(base) на CP-1.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.2, 9, 6 CP-1;
- docs/plan/services/04-backend-api.md, раздел M1.

Зона ответственности:
- services/backend/src/modules доменных ресурсов API-части;
- packages/contracts/openapi/backend-core (актуализация C3 base);
- запись audit_events для изменяющих операций.

Сделай:
1. Organization Management: GET/PATCH /organizations/{id} (ТЗ §16.3).
2. Configuration + история: GET/PUT /organizations/{id}/configuration с записью в
   configuration_history (ТЗ §22.10).
3. Client Management: GET/POST /clients, GET /clients/{id},
   POST /clients/{id}/notes, POST /clients/{id}/tags; endpoints/merge —
   проксирование к SVC-CORE.
4. User-домен (совместно с SVC-IDN): GET/POST /organizations/{id}/users,
   PATCH /users/{id}.
5. Проксирование к CORE: GET /conversations, GET /conversations/{id},
   GET /conversations/{id}/messages, GET /messages/{id}; POST /messages —
   идемпотентная передача в ядро.
6. Запись audit_events для изменяющих операций (ТЗ §22.9).

Проверка:
- unit: DTO-валидаторы клиентов/конфигурации, преобразователи, версионирование
  конфигурации;
- integration: Backend<->PostgreSQL для каждого ресурса — happy-path + изоляция
  арендатора + ошибка валидации (мастер §8.3); проксирование Backend<->CORE;
- e2e: участие в «Работа менеджера» и «Web Chat: приём и ответ».

Не делай:
- не реализуй Knowledge Base API — это M2;
- не реализуй фасады AI/FBP — это M3;
- не реализуй broadcast/notification фасады — это M4.
```

## M1-05 — SVC-INT: Web Chat Adapter и C6 Web Chat

```text
Выполни этап M1 плана docs/plan/services/05-integration-platform.md.

Цель: дать первый реальный канал вертикального среза — Web Chat Adapter,
нормализующий вход/исход в C1 и работающий через C2 Ingress/Egress; публикация C6
Web Chat.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.2, 6 CP-1, 8.4;
- docs/plan/services/05-integration-platform.md, раздел 5.2 M1.

Зона ответственности:
- services/integration-platform/src/adapters/web-chat;
- packages/contracts для C6 Web Chat;
- contract/integration INT<->CORE.

Сделай:
1. Реализуй Web Chat Adapter: нормализацию входящего в C1 и публикацию через C2
   Ingress (POST /internal/ingress/messages); доставку ответа (C2 Egress) в Web
   Chat.
2. Опубликуй C6 Web Chat: базовые возможности text, image, file, typing_indicator,
   read_receipt — по факту поддержки (ТЗ §10.6).
3. Реализуй каркас C3.channels для Web Chat: подключение/отдача возможностей.
4. Сохраняй сквозной idempotency_key (= message_id) при доставке.

Проверка:
- unit: нормализация вход/исход Web Chat (текст/вложения) в C1 и маппинг
  возможностей;
- integration: Backend<->Integration (ТЗ §26.4) — приём -> Ingress -> ядро; ответ
  -> Egress -> доставка (мок канала);
- contract: consumer-driven INT<->CORE (потребитель C2, поставщик C6);
- e2e: CP-1 «Web Chat: приём и ответ».

Не делай:
- не реализуй адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp — это M2;
- не наполняй Capability Model остальных каналов — это M2;
- не реализуй ретраи/бэкофф, rate limiting и идемпотентную массовую доставку — это
  M4;
- секреты канала храни как credentials_ref, не сам токен (ТЗ §23.7).
```

## M1-06 — SVC-CHAT: обмен сообщениями через ядро

```text
Выполни этап M1 плана docs/plan/services/13-web-chat.md.

Цель: замкнуть срез со стороны клиента — посетитель пишет в Web Chat, получает ответ
менеджера, видит статус доставки и базовую историю; публикация входящих через Web
Chat Endpoint (совместно с SVC-INT).

Исходные документы:
- docs/plan/README.md, разделы 3, 6 CP-1, 7.2, 8.2;
- docs/plan/services/13-web-chat.md, раздел 5.2 M1.

Зона ответственности:
- apps/web-chat;
- серверный Web Chat Endpoint в services/integration-platform/src/adapters/
  web-chat (совместно с SVC-INT);
- MSW mocks публичного API/WS до готовности ядра.

Сделай:
1. Инициализация сессии посетителя и создание/получение Conversation через ядро
   (анонимный режим, ТЗ §18.6, §8.13).
2. Отправка: POST /messages идемпотентно (клиентский idempotency_key, ТЗ §11.12)
   через публичный чат-API; приём ответа менеджера; отображение статуса доставки.
3. Базовая история: GET /conversations/{id}/messages.
4. Публикация входящих в ядро через Web Chat Endpoint (C2 Ingress, совместно с
   SVC-INT).

Проверка:
- unit: создание/восстановление сессии, формирование исходящего с idempotency_key,
  рендер статусов;
- integration: против мок-Backend/WS (MSW) или dev-стенда — отправка -> Ingress
  через Web Chat Endpoint -> сохранение; базовая история;
- e2e: CP-1 «Web Chat: приём и ответ».

Не делай:
- не реализуй AI-ответы в ленте и realtime по WS/reconnect (C7) — это M2;
- не реализуй подключение клиентов РФ через Edge и буфер/дедуп при разрыве — это M4;
- не дублируй компоненты — переиспользуй packages/ui-kit (ТЗ §21.3).
```

## M1-07 — SVC-MWS: очередь, история, отправка ответа

```text
Выполни этап M1 плана docs/plan/services/12-manager-workspace.md.

Цель: базовый цикл менеджера «очередь -> выбор диалога -> история -> ответ» против
C3; итог — e2e «Работа менеджера».

Исходные документы:
- docs/plan/README.md, разделы 3, 6 CP-1, 7.2, 8.2;
- docs/plan/services/12-manager-workspace.md, раздел M1.

Зона ответственности:
- apps/manager-workspace;
- потребление C3.auth/C3.conversations/C3.messages/C3.clients (реальные или MSW);
- consumer-driven contract-тесты потребителя C3.

Сделай:
1. Реальная auth через C3.auth (Telegram-код, ТЗ §9.5), работа в рамках сессии.
2. Очередь/список диалогов: GET /conversations (строки с последним сообщением и
   статусом, поиск клиентов).
3. История переписки: GET /conversations/{id}/messages (единая Conversation, пузыри
   по direction/sender_type, просмотр вложений).
4. Отправка ответа: POST /messages идемпотентно (idempotency_key); оптимистичное
   отображение + примирение статуса.
5. Карточка клиента (базовая): GET /clients/{id}.

Проверка:
- unit: компоненты списка/переписки/ввода; повтор POST /messages не создаёт дубль;
- integration: против MSW-моков C3;
- e2e: «Работа менеджера» (очередь -> история -> ответ) и участие в «Авторизация».

Не делай:
- не реализуй realtime по WS и панель AI-подсказок — это M2 (до M2 допустим
  polling/refetch);
- не реализуй интерфейс уведомлений — это M3;
- проверки прав не веди в UI — авторитетная авторизация на Backend (ТЗ §9.8).
```

## M1-08 — SVC-ADMIN: вход, организация и конфигурация

```text
Выполни этап M1 плана docs/plan/services/11-saas-administration.md.

Цель: администратор входит в систему и управляет организацией и её конфигурацией;
участие в e2e «Авторизация» совместно с SVC-IDN на CP-1.

Исходные документы:
- docs/plan/README.md, разделы 3, 7.2, 8.2, 6 CP-1;
- docs/plan/services/11-saas-administration.md, раздел M1.

Зона ответственности:
- apps/saas-admin;
- потребление C3.auth и C3.org (реальные или MSW);
- Playwright-сценарий «Авторизация».

Сделай:
1. Экран входа (C3.auth: ввод Telegram-имени -> одноразовый код -> сессия,
   ТЗ §9.5); хранение/продление сессии, выход.
2. Экран организации и редактор конфигурации (C3.org, ТЗ §16.3) с отображением
   серверных ошибок валидации.
3. Каркас навигации по разделам; условный рендеринг по роли (ТЗ §9.8).

Проверка:
- unit: форма входа, форма конфигурации, отображение ошибок валидации;
- integration (MSW): сценарий входа и сохранения конфигурации против мок-Backend;
- e2e: «Авторизация» (Playwright) совместно с SVC-IDN на CP-1.

Не делай:
- не реализуй разделы каналов и Knowledge Base — это M2;
- не реализуй визуальный редактор Workflow и AI Onboarding — это M3;
- не реализуй Broadcast и настройки Notification — это M4;
- условный рендеринг по роли — только UX-подсказка, не авторизация (ТЗ §9.8).
```

## M1-99 — Интеграционный gate M1 (CP-1)

```text
Выполни интеграционный gate CP-1 для завершения M1 после выполнения M1-01...M1-08.

Цель: убедиться, что вертикальный срез «приём и ответ» замыкается сквозным
сценарием, и заморозить C1/C2/C3/C7 на живом примере Web Chat.

Исходные документы:
- docs/plan/README.md, разделы 5, 6 CP-1, 7, 8.2, 9;
- docs/plan/services/{01,02,03,04,05,11,12,13}-*.md, только разделы M1.

Зона ответственности:
- tests/e2e для сценариев M1;
- tests/contract для INT<->CORE и потребителей C3;
- packages/contracts (заморозка версий C1/C2/C3/C7);
- CI jobs; docs/plan status notes, если нужно.

Сделай:
1. Собери и прогони e2e «Web Chat: приём и ответ», «Авторизация», «Работа
   менеджера» (мастер §8.2) на связке SVC-CHAT + SVC-INT(Web Chat) + SVC-CORE +
   SVC-API + SVC-IDN + SVC-MWS.
2. Добавь и проверь contract-тест INT<->CORE (потребитель C2 — Web Chat Adapter)
   и consumer-driven contracts потребителей C3 (MWS/ADMIN).
3. Проверь сквозные инварианты среза: изоляция арендаторов (RLS), идемпотентность
   POST /messages (повтор idempotency_key не создаёт дубль), переходы статусов
   received -> routed -> sent, аудит изменяющих операций.
4. Зафиксируй заморозку C1/C2/C3/C7 на CP-1 и отметь в планах сервисов завершение
   этапа M1.
5. Сформируй список готовности к M2: что уже стабильно (C1/C2/C3/C7) и что входит
   в M2 (адаптеры, realtime, AI Assistant, identity resolution).

Проверка:
- workspace lint/test/build;
- integration + contract + e2e затронутых сценариев (§ 9.4);
- если есть docker-compose стенд, подними связку M1 и прогони срез end-to-end.

Не делай:
- не переписывай чужие сервисные реализации крупными правками; если найден
  конфликт контрактов или ownership, зафиксируй его как blocker и предложи
  минимальный patch;
- не забегай в M2 (realtime, внешние адаптеры, AI) сверх фиксации границ.
```

---

# 5. Что запускать первым

Минимальный практичный запуск M1:

1. Выполнить **M1-01** (SVC-DATA) — обязательный предшественник: без реальной схемы
   среза integration-тесты ядра не проходят.
2. Как только схема готова, параллельно запустить ядро и клиентов среза:
   **M1-02** (CORE), **M1-03** (IDN), **M1-04** (API), **M1-05** (INT Web Chat),
   **M1-06** (CHAT), **M1-07** (MWS), **M1-08** (ADMIN). Бэкенд-модули (CORE/IDN/API)
   идут против реальной схемы SVC-DATA; фронтенды и адаптер — против моков M0 до
   сборки живого среза.
3. Сервисы без задач на M1 (SVC-AI, SVC-FBP — моки из M0; SVC-BCAST, SVC-NOTIF,
   SVC-EDGE, SVC-TGC, SVC-MOB — «—») не запускать: их артефакты M0 сохраняются под
   регрессией.
4. После слияния результатов выполнить **M1-99** (gate CP-1) и только затем
   открывать серию M2-промптов для CP-2/CP-3.
