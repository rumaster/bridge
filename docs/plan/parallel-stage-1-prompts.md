---
title: Первая серия промптов для параллельного выполнения этапа M0
subtitle: Последовательность старта разработки и набор независимых задач для исполнителей
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/README.md (v1.0)
---

# Первая серия промптов для параллельного выполнения этапа M0

Документ отвечает на issue #5: анализирует план, фиксирует порядок выполнения и
даёт первую серию промптов для параллельного старта разработки.

Под «первым этапом» здесь понимается **M0 — Контракты и каркас** из
[`docs/plan/README.md`](./README.md). M1 — первый пользовательский вертикальный
срез, но запускать M1 без M0 нельзя: в M0 замораживаются контракты, создаются
моки и поднимается CI-скелет, на котором команды смогут работать независимо.

---

# 1. Итоговая последовательность выполнения

## 1.1 Общая последовательность вех

1. **M0 — Контракты и каркас.** Общий старт: структура репозитория, CI-скелет,
   контракты v1, моки и базовые приложения/сервисы.
2. **M1 — Вертикальный срез «приём и ответ».** Web Chat → Core → Manager
   Workspace → ответ клиенту; точка согласования **CP-1**.
3. **M2 — Омниканальность + realtime + AI Assistant.** Внешние адаптеры,
   WebSocket realtime, AI Assistant из Knowledge Base; **CP-2**, **CP-3**.
4. **M3 — Программируемость.** FBP, визуальный редактор Workflow, AI Onboarding,
   Notification; **CP-4**, **CP-5**.
5. **M4 — Broadcast + Edge/ПДн + Mobile/Telegram Console.** Массовые коммуникации,
   RF Edge, буферизация, Mobile API, Telegram Console; **CP-6**, **CP-7**,
   **CP-8**.
6. **M5 — Стабилизация и приёмка.** Полный e2e-набор, нагрузка, безопасность,
   RPO/RTO, документация; **CP-9**.

Критический путь до первого работающего сценария:

```text
M0 contracts/mocks
  -> SVC-DATA M1 schema
  -> SVC-CORE M1 ingress/storage/routing
  -> CP-1: SVC-CHAT + SVC-INT(Web Chat) + SVC-API + SVC-IDN + SVC-MWS
```

## 1.2 Внутренний порядок M0

M0 лучше выполнять в три шага:

1. **M0-00, короткий обязательный предшественник.** Репозиторный каркас:
   workspaces, единые команды, директории, общий CI и пустые пакеты
   `packages/contracts`, `packages/ui-kit`, `packages/api-client`,
   `packages/testing`.
2. **M0-01...M0-14, параллельная волна.** Владельцы сервисов создают свои
   контракты, моки, каркасы и тесты в пределах своих зон ответственности.
   **M0-15** можно запускать параллельно как необязательную подготовку, но он не
   блокирует завершение M0.
3. **M0-99, интеграционный gate.** Проверка, что контракты не конфликтуют, моки
   поднимаются, CI зелёный, а M1-команды могут стартовать без ручных договорённостей.

---

# 2. Правила для исполнителей первой серии

- Каждый исполнитель берёт **ровно один** промпт из раздела 4.
- Формулировка задачи должна звучать как: «Выполнить этап **M0** плана
  `docs/plan/services/XX-...md`».
- Нельзя реализовывать бизнес-функциональность будущих вех M1+ сверх моков и
  каркаса, если это не нужно для прохождения M0.
- Контрактные артефакты кладутся в `packages/contracts`; код сервиса — только в
  директорию сервиса из мастер-плана.
- Если задача зависит от ещё не готового соседнего контракта, исполнитель
  использует мок/заглушку и явно фиксирует ожидание в README или тесте контракта.
- Для каждого промпта результатом должны быть код/документация, тесты и короткий
  отчёт: что сделано, какие команды проверки запущены, какие контракты затронуты.

---

# 3. Критерии готовности M0

M0 считается завершённой, когда:

- структура монорепозитория соответствует мастер-плану §3;
- все контракты M0 опубликованы в `packages/contracts` и имеют начальную версию;
- каждый сервис M0 имеет каркас, health-check или мок там, где это предусмотрено
  сервисным планом;
- фронтенд-приложения M0 собираются против моков/MSW;
- CI запускает lint, unit, build и доступные integration/contract проверки;
- для M1 есть готовые моки C1/C2/C3/C7 и seeded/test данные, чтобы стартовать
  CP-1 без ручного переписывания контрактов.

---

# 4. Первая серия промптов

## M0-00 — Репозиторный каркас и общий CI

```text
Выполни этап M0 общего мастер-плана docs/plan/README.md в части репозиторного
каркаса.

Цель: подготовить минимальную структуру монорепозитория, чтобы остальные M0-задачи
могли выполняться параллельно без споров о директориях, пакетах и командах.

Исходные документы:
- docs/plan/README.md, разделы 3, 5, 8, 9.

Зона ответственности:
- package/workspace configuration в корне;
- .github/workflows;
- пустые/минимальные packages/contracts, packages/ui-kit, packages/api-client,
  packages/testing;
- базовые директории apps/, services/, clients/, db/, tests/, deploy/.

Сделай:
1. Создай минимальный workspace-каркас с едиными командами lint, test, build.
2. Подготовь директории из мастер-плана §3 без бизнес-логики.
3. Добавь базовый CI: lint -> unit -> build; integration/contract/e2e можно
   оставить как отдельные jobs-заглушки, если реализации ещё нет.
4. Добавь README для packages/contracts с правилами semver и ownership контрактов.
5. Добавь smoke-тест или минимальную проверку, что workspace-команды запускаются.

Проверка:
- запусти доступные локальные команды lint/test/build;
- если часть команд пока заглушки, укажи это явно в итоговом отчёте.

Не делай:
- не реализуй M1-функциональность;
- не добавляй реальные внешние интеграции.
```

## M0-01 — SVC-DATA: схема v1 и каркас миграций

```text
Выполни этап M0 плана docs/plan/services/01-data-platform.md.

Цель: дать командам ядра рабочую БД, механизм миграций, RLS-каркас и детерминированные
сиды для ролей/демо-организации.

Исходные документы:
- docs/plan/README.md, разделы 4, 5, 8, 9, 10.1;
- docs/plan/services/01-data-platform.md, раздел 5.1 M0.

Зона ответственности:
- db/migrations;
- db/seeds;
- тестовые фикстуры БД в packages/testing или сервисной test-директории.

Сделай:
1. Выбери и зафиксируй механизм миграций, совместимый с будущим NestJS backend.
2. Реализуй M0-схему: organizations, roles, минимальный users, RLS-каркас.
3. Добавь сиды roles: platform_operator, administrator, manager; демо-организацию
   и seeded-admin для будущего M1.
4. Настрой Testcontainers/локальный integration test для PostgreSQL 16 + pgvector.
5. Проверь миграции по циклу up -> down -> up.

Проверка:
- unit: фабрики/валидаторы uuid и timestamptz;
- integration: применение миграций, extension vector, RLS активен.

Не делай:
- не добавляй M1-таблицы messages/conversations/clients, кроме если они нужны как
  пустые forward-compatible заглушки и явно помечены как неиспользуемые.
```

## M0-02 — SVC-CORE: C1/C2 и мок Ingress/Egress

```text
Выполни этап M0 плана docs/plan/services/03-communication-core.md.

Цель: заморозить C1 Message Model и C2 Ingress/Egress, чтобы SVC-INT, SVC-CHAT,
SVC-MWS и SVC-API могли работать против стабильных моков.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.2, 7.3, 8.4;
- docs/plan/services/03-communication-core.md, раздел M0.

Зона ответственности:
- packages/contracts/message-model;
- packages/contracts/openapi или json-schema для C2;
- services/backend/src/modules/communication-core;
- contract-заготовки tests/contract для INT<->CORE.

Сделай:
1. Опиши C1: message id/idempotency_key, organization_id, conversation_id,
   endpoint_id, channel, direction, sender_type, sequence_number, type, content,
   status, timestamps.
2. Опиши C2 Ingress POST /internal/ingress/messages и Egress Core->Adapter.
3. Зафиксируй конечный автомат статусов минимум received -> routed -> sent.
4. Подними мок Ingress и мок Egress без реальной доставки.
5. Добавь unit-тесты валидации DTO и contract-заготовку INT<->CORE.

Проверка:
- unit для C1/C2 DTO и статусов;
- contract smoke, что мок принимает валидное сообщение и отклоняет невалидное.

Не делай:
- не реализуй M1-хранение сообщений и маршрутизацию в БД.
```

## M0-03 — SVC-IDN: C3.auth и мок AuthGuard

```text
Выполни этап M0 плана docs/plan/services/02-identity-platform.md.

Цель: заморозить контракт C3.auth и дать остальным backend/frontend модулям мок
авторизации для параллельной разработки.

Исходные документы:
- docs/plan/README.md, раздел 7.2 C3.auth;
- docs/plan/services/02-identity-platform.md, раздел M0.

Зона ответственности:
- packages/contracts/openapi/auth;
- services/backend/src/modules/identity;
- общий mock AuthGuard для backend-модулей.

Сделай:
1. Опиши OpenAPI/DTO для POST /auth/login/telegram/start,
   POST /auth/login/telegram/verify, POST /auth/logout, GET /auth/session.
2. Создай каркас identity-модуля и заглушки эндпоинтов.
3. Реализуй mock AuthGuard с seeded user/organization/role из SVC-DATA M0.
4. Добавь unit-тесты DTO и contract-тест публикации C3.auth.
5. Документируй, что реальная проверка code_hash/session относится к M1.

Проверка:
- unit DTO validation;
- contract smoke для C3.auth;
- backend skeleton запускается с mock AuthGuard.

Не делай:
- не реализуй реальный Telegram login flow и хранение sessions/login_codes M1.
```

## M0-04 — SVC-API: Backend REST skeleton и C3 base

```text
Выполни этап M0 плана docs/plan/services/04-backend-api.md.

Цель: поднять NestJS backend skeleton, единый REST-каркас /api/v1, формат ошибок,
валидацию, идемпотентность и OpenAPI-генерацию для C3.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 9;
- docs/plan/services/04-backend-api.md, раздел M0.

Зона ответственности:
- services/backend/src/common;
- services/backend/src/main.ts и backend app skeleton;
- packages/contracts/openapi/backend-core;
- health/metrics skeleton.

Сделай:
1. Настрой версионирование /api/v1 и базовую структуру модулей backend.
2. Добавь глобальный ValidationPipe и ExceptionFilter с единым форматом ошибок.
3. Добавь общий каркас query DTO для pagination/filter/search.
4. Добавь IdempotencyInterceptor с in-memory/mock хранилищем ключей для M0.
5. Настрой OpenAPI/Swagger export в packages/contracts/openapi.
6. Добавь GET /health и GET /metrics; заглушки фасадов AI/FBP/BCAST/NOTIF.

Проверка:
- unit: формат ошибок, validators, pagination DTO, request-id, idempotency logic;
- integration: backend starts, /health returns ok.

Не делай:
- не реализуй доменные CRUD M1.
```

## M0-05 — SVC-INT: C2 consumer, C6 и мок адаптера

```text
Выполни этап M0 плана docs/plan/services/05-integration-platform.md.

Цель: согласовать потребление C2, определить C6 Capability Descriptor и поднять
мок адаптера для ядра и фронтендов.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.2;
- docs/plan/services/05-integration-platform.md, раздел 5.1 M0.

Зона ответственности:
- services/integration-platform;
- packages/contracts для C6;
- contract/integration smoke INT<->CORE.

Сделай:
1. Зафиксируй, как Adapter вызывает C2 Ingress и принимает C2 Egress.
2. Определи C6: text, image, file, voice, video, buttons, reactions,
   typing_indicator, read_receipt, delete, edit.
3. Создай мок-адаптер: эмулирует входящее сообщение и принимает исходящую доставку.
4. Добавь каркас сервиса, GET /health, GET /metrics.
5. Добавь unit-тест C6 validator и integration smoke mock-adapter <-> mock-core.

Проверка:
- unit C6 schema;
- integration: входящее -> Ingress mock, Egress -> channel stub.

Не делай:
- не реализуй Web Chat Adapter M1 и реальные внешние каналы M2.
```

## M0-06 — SVC-CHAT: каркас виджета и роль первого канала

```text
Выполни этап M0 плана docs/plan/services/13-web-chat.md.

Цель: создать встраиваемый Web Chat widget skeleton и зафиксировать Web Chat как
первый канал для будущего CP-1.

Исходные документы:
- docs/plan/README.md, разделы 3, 5, 6 CP-1, 8.2;
- docs/plan/services/13-web-chat.md, раздел 5.1 M0.

Зона ответственности:
- apps/web-chat;
- MSW mocks для C3.messages/C1/C7;
- документация по embed/mount point.

Сделай:
1. Инициализируй React + Vite + TypeScript приложение/виджет.
2. Настрой встраиваемый bundle: mount point, lazy loading, базовая лента и input.
3. Подключи packages/ui-kit и packages/api-client, если они готовы; иначе добавь
   локальную временную заглушку с TODO на замену.
4. Подними MSW mock API/WS для C3.messages/C1.
5. Добавь unit-тесты: mount widget, empty thread render, message input render.
6. В README приложения зафиксируй, что Web Chat является первым каналом CP-1.

Проверка:
- unit frontend tests;
- build widget;
- MSW mock starts.

Не делай:
- не реализуй реальный обмен сообщениями через ядро M1.
```

## M0-07 — SVC-MWS: каркас Manager Workspace

```text
Выполни этап M0 плана docs/plan/services/12-manager-workspace.md.

Цель: создать skeleton рабочего места менеджера, который в M1 сможет потреблять
C3.auth, C3.conversations, C3.messages, C3.clients и C7.

Исходные документы:
- docs/plan/README.md, разделы 3, 6 CP-1, 7.2, 7.3;
- docs/plan/services/12-manager-workspace.md, раздел M0.

Зона ответственности:
- apps/manager-workspace;
- MSW mocks C3.* и C7;
- frontend route skeleton.

Сделай:
1. Инициализируй React + Vite + TypeScript приложение.
2. Создай слои Presentation/API Client/State/Routing/Shared.
3. Добавь маршруты-заглушки: login, conversation queue, dialog, notifications.
4. Подключи ui-kit/api-client или временные типизированные заглушки.
5. Добавь auth-заглушку против mock C3.auth.
6. Подними MSW для C3.* и C7.

Проверка:
- unit: render shell, routing, smoke ui-kit;
- integration: MSW mocks start;
- build frontend.

Не делай:
- не реализуй M1 очередь, историю и отправку ответа.
```

## M0-08 — SVC-ADMIN: каркас SaaS Administration

```text
Выполни этап M0 плана docs/plan/services/11-saas-administration.md.

Цель: создать skeleton админ-панели, который готов к M1 login/org/configuration и
к будущим разделам channels, KB, workflow, broadcast, notification.

Исходные документы:
- docs/plan/README.md, разделы 3, 7.2, 9;
- docs/plan/services/11-saas-administration.md, раздел M0.

Зона ответственности:
- apps/saas-admin;
- MSW mocks для C3.auth/C3.org;
- frontend routing/layout skeleton.

Сделай:
1. Инициализируй React + Vite + TypeScript приложение.
2. Настрой routing, layout, protected routes и lazy loading.
3. Подключи ui-kit и api-client, если готовы; иначе временные typed stubs.
4. Добавь auth-заглушку и MSW mocks.
5. Подготовь Playwright skeleton без реального e2e сценария.
6. Добавь unit-тесты shell/routing/protected route guard.

Проверка:
- unit frontend tests;
- build;
- MSW mock starts.

Не делай:
- не реализуй M1 формы входа, организации и конфигурации.
```

## M0-09 — SVC-AI: C4 и детерминированный мок AI

```text
Выполни этап M0 плана docs/plan/services/06-ai-platform.md.

Цель: заморозить C4 и поднять детерминированный мок AI, чтобы ядро и фронтенды не
зависели от реальных LLM.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 8.4, 10;
- docs/plan/services/06-ai-platform.md, раздел M0.

Зона ответственности:
- services/ai-platform;
- packages/contracts/openapi/ai;
- packages/contracts/json-schema для structured commands;
- services/backend facade stub ai-integration, если backend skeleton уже есть.

Сделай:
1. Опиши C4: POST /ai/assistant:suggest и POST /ai/onboarding:command.
2. Опиши JSON Schema структурированной команды AI Onboarding.
3. Реализуй deterministic mock AI с фиксированными ответами на фиксированные inputs.
4. Добавь фасадную заглушку деградации: timeout/unavailable -> controlled fallback.
5. Добавь unit-тесты DTO и JSON Schema positive/negative.

Проверка:
- unit DTO/schema;
- contract smoke C4;
- mock AI starts and returns deterministic responses.

Не делай:
- не подключай реальные LLM и RAG M2.
```

## M0-10 — SVC-FBP: C5 и мок FBP

```text
Выполни этап M0 плана docs/plan/services/07-fbp-engine.md.

Цель: заморозить C5 и поднять мок FBP, чтобы ядро не зависело от реального
workflow engine до CP-4.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 8.4, 10;
- docs/plan/services/07-fbp-engine.md, раздел M0.

Зона ответственности:
- services/fbp-engine;
- packages/contracts/openapi/fbp;
- contract-заготовки API<->FBP;
- license note по fbp-engine.

Сделай:
1. Опиши C5: POST /workflows/{id}/instances с version/context и callback Backend API node.
2. Опиши событие workflow.state_changed.
3. Подними мок FBP: start workflow -> deterministic instance id/state; callback stub.
4. Проверь и зафиксируй лицензионное ограничение fbp-engine до включения upstream-кода.
5. Добавь unit-тесты DTO start/callback и contract smoke API<->FBP.

Проверка:
- unit DTO;
- contract smoke;
- mock FBP starts.

Не делай:
- не форкай и не перерабатывай настоящий fbp-engine M3.
```

## M0-11 — SVC-BCAST: C8 и мок Broadcast

```text
Выполни этап M0 плана docs/plan/services/08-broadcast-platform.md.

Цель: заморозить C8 и поднять мок Broadcast для будущей разработки UI и ядра.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.4;
- docs/plan/services/08-broadcast-platform.md, раздел M0.

Зона ответственности:
- services/broadcast-platform;
- packages/contracts/openapi/broadcasts;
- backend facade stub broadcast-facade, если backend skeleton уже есть.

Сделай:
1. Опиши C8: GET/POST /broadcasts, POST /broadcasts/{id}:start,
   GET /broadcasts/{id}/stats.
2. Опиши DTO template/filter/schedule/rate_limit/stats.
3. Подними мок C8 с deterministic campaign/stat responses.
4. Добавь unit-тесты DTO create/start/stats.
5. Добавь contract-заготовку BCAST<->CORE для будущей доставки через C1/C2.

Проверка:
- unit DTO;
- contract smoke;
- mock service starts.

Не делай:
- не реализуй планирование кампаний M3 и доставку M4.
```

## M0-12 — SVC-NOTIF: C10 и мок Notification

```text
Выполни этап M0 плана docs/plan/services/09-notification-platform.md.

Цель: заморозить C10 и схему notification.created для будущих продюсеров и
потребителей уведомлений.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 7.3, 8.4;
- docs/plan/services/09-notification-platform.md, раздел M0.

Зона ответственности:
- services/notification-platform;
- packages/contracts/openapi/notifications;
- packages/contracts/events для notification.created;
- backend facade stub notification-facade, если backend skeleton уже есть.

Сделай:
1. Опиши C10: GET /notifications, POST /notifications/{id}:read,
   GET/PUT /notifications/settings.
2. Опиши WS-событие notification.created в составе C7.
3. Подними мок C10 и мок события.
4. Добавь unit-тесты DTO и event schema.
5. Добавь contract-заготовки producers<->NOTIF и NOTIF<->MWS/TGC.

Проверка:
- unit DTO/event schema;
- contract smoke;
- mock service starts.

Не делай:
- не реализуй реальную генерацию и доставку M3.
```

## M0-13 — SVC-EDGE: C9 и уточнение C7

```text
Выполни этап M0 плана docs/plan/services/10-edge-websocket-gateway.md.

Цель: заморозить C9 Edge<->App Tunnel и уточнить C7 WebSocket events/reconnect,
чтобы ядро и клиенты могли проектировать realtime и RF Edge без дрейфа.

Исходные документы:
- docs/plan/README.md, разделы 7.1, 7.3, 8.4;
- docs/plan/services/10-edge-websocket-gateway.md, раздел M0.

Зона ответственности:
- services/edge-gateway;
- packages/contracts/events или openapi для C9/C7;
- contract-заготовки EDGE<->CORE.

Сделай:
1. Опиши C9: tunnel message with sequence_number, idempotency_key, endpoint_id,
   payload, timestamps.
2. Уточни C7: GET /ws, events message.created, message.status_changed,
   typing.started/stopped, client.status_changed, notification.created,
   broadcast.state_changed, workflow.state_changed; авто-reconnect semantics.
3. Подними мок tunnel и мок WS-channel.
4. Добавь unit-тесты DTO C9 и WS event schema.
5. Добавь contract smoke EDGE<->CORE.

Проверка:
- unit DTO/event schema;
- contract smoke;
- mock tunnel/ws starts.

Не делай:
- не реализуй реальный WebSocket Gateway M2 и RF Edge/VPN M4.
```

## M0-14 — SVC-MOB: мобильный контракт и мок Mobile API

```text
Выполни этап M0 плана docs/plan/services/15-mobile-api.md.

Цель: заморозить независимый мобильный контракт /mobile/v1 и поднять мок Mobile
API для будущей разработки мобильного клиента.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.4;
- docs/plan/services/15-mobile-api.md, раздел M0.

Зона ответственности:
- services/mobile-api;
- packages/contracts/openapi/mobile;
- contract-заготовки app<->SVC-MOB и потребления C3/C7/C10/C9.

Сделай:
1. Опиши /mobile/v1 aggregated endpoints: dialogs/messages/notifications,
   GET /mobile/v1/sync, POST /mobile/v1/devices, auth proxy.
2. Зафиксируй независимый semver мобильного API.
3. Подними мок mobile-api.
4. Добавь unit-тесты DTO, sync cursor format, notification -> push payload mapping stub.
5. Добавь contract-заготовки mobile app<->SVC-MOB и SVC-MOB consumer contracts.

Проверка:
- unit DTO/cursor/push payload stub;
- contract smoke;
- mock mobile-api starts.

Не делай:
- не реализуй реальную агрегацию, push, offline sync M4.
```

## M0-15 — SVC-TGC: необязательный подготовительный каркас

```text
Выполни только допустимую подготовительную часть M0 плана
docs/plan/services/14-telegram-console.md.

Цель: подготовить необязательный skeleton Telegram Console без включения его в
критический путь M0/M1.

Исходные документы:
- docs/plan/README.md, разделы 5.1, 7.2;
- docs/plan/services/14-telegram-console.md, раздел M0/M1/M2.

Зона ответственности:
- clients/telegram-console;
- mock Telegram API adapter;
- README с указанием, что основная работа начинается в M3.

Сделай:
1. Создай минимальный skeleton клиента telegram-console.
2. Добавь skeleton handlers для команд/кнопок против mock Telegram API.
3. Добавь черновую точку привязки аккаунта поверх будущего C3.auth, без реальной логики.
4. Добавь unit smoke для handler routing.
5. Явно зафиксируй, что задача не блокирует M0 gate и CP-1.

Проверка:
- unit smoke;
- build skeleton, если workspace уже готов.

Не делай:
- не реализуй уведомления, просмотр диалога и ответ клиенту M3.
```

## M0-99 — Интеграционный gate M0

```text
Выполни интеграционный gate для завершения M0 после выполнения M0-00...M0-14.

Цель: проверить, что первая волна дала согласованный набор контрактов, моков и
скелетов, достаточный для старта M1/CP-1.

Исходные документы:
- docs/plan/README.md, разделы 5, 6, 7, 8, 9;
- все docs/plan/services/*.md, только M0-разделы.

Зона ответственности:
- packages/contracts registry/index;
- tests/contract smoke suite;
- CI jobs;
- docs/plan status notes, если нужно.

Сделай:
1. Проверь, что C1/C2/C3.auth/C3 base/C4/C5/C6/C7/C8/C9/C10 и mobile contract
   опубликованы и не конфликтуют по именам, версиям и DTO.
2. Добавь общий contract smoke: каждый мок поднимается, health отвечает, базовый
   валидный request проходит schema validation.
3. Проверь, что frontend skeletons используют MSW/api-client без ручного patching.
4. Проверь, что backend skeleton собирает модули CORE/IDN/API и не требует реальных
   AI/FBP/BCAST/NOTIF/INT.
5. Сформируй список готовности к M1: что уже готово для CP-1 и что остаётся
   входным условием M1.

Проверка:
- workspace lint/test/build;
- contract smoke suite;
- если есть docker-compose skeleton, подними только M0 mocks/health.

Не делай:
- не исправляй чужие сервисные реализации крупными переписываниями; если найден
  конфликт ownership, зафиксируй его как blocker и предложи минимальный patch.
```

---

# 5. Что запускать первым

Минимальный практичный запуск:

1. Выполнить **M0-00**.
2. Параллельно запустить критический набор для CP-1:
   **M0-01**, **M0-02**, **M0-03**, **M0-04**, **M0-05**, **M0-06**, **M0-07**.
3. Параллельно или сразу следом запустить не блокирующие M0-контракты:
   **M0-08** ... **M0-14**.
4. **M0-15** запускать только при свободной ёмкости, потому что SVC-TGC не блокирует
   M0/M1.
5. После слияния результатов выполнить **M0-99** и только затем открывать серию
   M1-промптов для CP-1.
