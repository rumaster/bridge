# Contracts

`packages/contracts` - единый источник контрактов платформы: OpenAPI,
каноническая модель сообщения, схемы событий и JSON Schema для структурированных
команд AI.

## Каталоги

- `openapi/` - публичные и внутренние REST API.
- `message-model/` - каноническая модель сообщения Communication Core.
- `events/` - WebSocket-события, outbox-события и внутренние события.
- `json-schema/` - схемы структурированных команд AI и вспомогательных DTO.

## M0 C1/C2

- `message-model/message.schema.json` - C1 Canonical Message v1.0.0:
  `id` равен `idempotency_key`, обязательны `organization_id`,
  `conversation_id`, `endpoint_id`, `channel`, `direction`, `sender_type`,
  `sequence_number`, `type`, `content`, `status`, `created_at`, `updated_at`.
- `message-model/status-machine.v1.json` - минимальный автомат статусов:
  `received -> routed -> sent`, с терминальными `delivered` и `failed`.
- `openapi/communication-core-c2.openapi.json` - C2 Ingress
  `POST /internal/ingress/messages` и Egress
  `POST /internal/egress/messages` для mock handoff Core -> Adapter без реальной
  доставки.

## M1-03: C3.auth для Identity Platform

- `openapi/auth/c3.auth.openapi.json` фиксирует C3.auth v1.0.0 на CP-1:
  Telegram start/verify, server session, logout.
- `start` создаёт challenge id, хранит только `code_hash` и отдаёт TTL.
- `verify` принимает `requestId` или `telegramUsername` вместе с кодом, помечает
  `login_codes.consumed_at` и возвращает непрозрачный server session token.
- Session endpoints используют Bearer/cookie token; в БД хранится только
  `auth_sessions.token_hash`.

## CP-1: заморозка C1/C2/C3/C7 для M2

- `cp1-freeze.v1.json` фиксирует gate M1 (CP-1) от 2026-07-03: C1, C2, C3 и C7
  имеют статус `stable_for_m2`.
- `src/registry.mjs` экспортирует `CP1_CONTRACT_FREEZE`,
  `CP1_GATE_REQUIRED_CONTRACT_IDS` и `validateCp1ContractFreeze()` для
  машинной проверки freeze.
- C3 на CP-1 агрегирует `openapi/backend-core/openapi.json`,
  `openapi/auth/c3.auth.openapi.json`, consumer contract SVC-MWS и consumer
  contract SVC-ADMIN.
- M2 readiness: стабильные C1/C2/C3/C7; следующий scope — adapters, realtime,
  AI Assistant и identity resolution.

## CP-2/CP-3: заморозка C2/C6/C4 для M3

- `cp2-cp3-freeze.v1.json` фиксирует gate M2 (CP-2 + CP-3) от 2026-07-03:
  C2, C6 и C4 имеют статус `stable_for_m3`.
- `src/registry.mjs` экспортирует `CP2_CP3_CONTRACT_FREEZE`,
  `CP2_CP3_GATE_REQUIRED_CONTRACT_IDS` и `validateCp2Cp3ContractFreeze()` для
  машинной проверки freeze.
- CP-2 закрыт e2e «Telegram: приём и ответ» и per-adapter contract INT↔CORE:
  каждый adapter потребляет C2 Ingress и публикует C6 Capability Descriptor.
- CP-3 закрыт e2e «AI Assistant из KB» и consumer contract API↔AI: C4
  сохраняет shape v1, KB-поиск изолирован по `organization_id`, а деградация AI
  возвращает валидный C4 fallback без блокировки переписки.
- M3 readiness: стабильные C2/C6/C4; следующий scope — outbox/domain events,
  FBP/Workflow, AI Onboarding, Notification и фасады `ai-integration`/
  `fbp-integration` с circuit breaker.

## CP-3: SVC-MWS consumer C4/C7

- `consumer/manager-workspace-c4-c7.consumer.v1.json` фиксирует потребление
  SVC-MWS контракта C4 `POST /ai/assistant:suggest` и C7 событий
  `message.created`, `message.status_changed`, `typing.*`, `client.status_changed`.
- Reconnect-инварианты клиента: transport cursor `last_event_id`, дедупликация
  событий по `event_id`, сообщений по `payload.message.id`, gap detection по
  `sequence_number`.

## M0-05: C2/C6 для Integration Platform

- `openapi/c2-internal-api.yaml` фиксирует mock C2: Adapter вызывает Core
  через `POST /internal/ingress/messages`, Core вызывает Adapter через
  `POST /internal/egress/deliveries`.
- `json-schema/c2-ingress-message.schema.json` и
  `json-schema/c2-egress-delivery.schema.json` описывают M0-обёртки вокруг
  mock C1 сообщения.
- `json-schema/c6-capability-descriptor.schema.json` и `src/c6.mjs`
  фиксируют C6 v1. Обязательный набор возможностей: `text`, `image`, `file`,
  `voice`, `video`, `buttons`, `reactions`, `typing_indicator`,
  `read_receipt`, `delete`, `edit`.

## M0-09: C4 для AI Platform

- `openapi/ai/c4.ai.openapi.json` фиксирует C4 v1 для Backend API ↔ SVC-AI:
  `POST /ai/assistant:suggest` и `POST /ai/onboarding:command`.
- `json-schema/c4-ai-onboarding-command.schema.json` описывает структурированную
  команду AI Onboarding. Команда является только описанием действия; применять
  ее может только Backend после валидации структуры, полномочий и состояния.
- `src/c4.mjs` содержит M0-константы и легковесный валидатор JSON Schema для
  contract/unit smoke-тестов без дополнительных зависимостей.

## M0-12: C10 для Notification Platform

- `openapi/notifications/c10.notifications.openapi.json` фиксирует C10 v1:
  `GET /notifications`, `POST /notifications/{id}:read`,
  `GET/PUT /notifications/settings`.
- `consumer/telegram-console-cp8.consumer.v1.json` фиксирует CP-8/M4
  потребление SVC-TGC: Telegram login/session, C10 Telegram cards, C3
  dialogs/messages и C4 AI suggestions с graceful degradation.
- `events/notification-created.schema.json` описывает WS-событие C7
  `notification.created` для SVC-MWS/SVC-ADMIN.
- `events/notification-trigger.schema.json` фиксирует M0-заготовку события
  producer -> SVC-NOTIF для CORE/BCAST/AI/FBP.
- `src/c10.mjs` содержит константы, фабрики и легковесные валидаторы C10/C7.
## M0-13: C7/C9 для Edge & WebSocket Gateway

- `openapi/edge/c7.websocket.openapi.json` фиксирует C7 `GET /ws` как WebSocket
  upgrade, transport-фильтры подписки и семантику авто-reconnect через cursor
  `last_event_id` с fallback `after_sequence_number`.
- `events/c7-websocket-event.schema.json` фиксирует общий envelope C7 v1:
  `event_id`, `organization_id`, `sequence_number`, `payload`, `occurred_at` и
  события `message.created`, `message.status_changed`, `typing.started`,
  `typing.stopped`, `client.status_changed`, `channel.status_changed`,
  `notification.created`, `broadcast.state_changed`, `workflow.state_changed`.
- `openapi/edge/c9.edge-tunnel.openapi.json` фиксирует EDGE→CORE tunnel endpoint
  `POST /internal/edge/tunnel/messages`.
- `json-schema/c9-edge-tunnel-message.schema.json` фиксирует C9 v1 envelope с
  `sequence_number`, `idempotency_key`, `endpoint_id`, C1 `payload` и
  timestamps `received_at`, `buffered_at`, `forwarded_at`.
- `src/c7.mjs` и `src/c9.mjs` содержат M0-константы и лёгкие валидаторы для unit
  и contract smoke-тестов.

## M5-14: MOBILE.v1 для Mobile API

- `openapi/mobile/mobile.v1.openapi.json` фиксирует независимый мобильный API
  под `/mobile/v1`: auth proxy, aggregated dialogs/messages/notifications,
  `GET /sync`, `POST /devices` и отзыв устройства. M5 поднимает текущую minor
  версию до v1.1.0, но явно сохраняет поддержку опубликованных клиентов v1.0.0
  через `x-supported-versions`.
- `mobile/consumer-contracts.v1.json` содержит M5 consumer-driven
  контрактов для mobile app ↔ SVC-MOB и потребления SVC-MOB контрактов
  C3.auth, C3.conversations/messages/clients, C7, C9 и C10.notifications; M5
  фиксирует тот же список поддерживаемых версий.
- `src/mobile.mjs` содержит semver, base path, contract id и проверку формы
  sync cursor `mob1.<base64url-json>`.

## CP-9: приемка SVC-API M5

- `cp9-svc-api-acceptance.v1.json` фиксирует готовность C3 Backend REST API к
  CP-9: OpenAPI генерируется из кода, совпадает с фактическими `/api/v1`
  маршрутами и содержит M5-метаданные владельца/версии.
- `openapi/backend-core/openapi.json` является опубликованным C3 v1.0.0
  артефактом SVC-API. Ломающие изменения не меняют `/api/v1`, а публикуются в
  новой URL-версии.
- NFR-пороги ТЗ §25.2 закреплены как p95-пробы в
  `services/backend/test/integration/m5-nfr.spec.ts`: список диалогов,
  история, отправка сообщения и AI assistant без времени внешнего LLM.

## Ownership

Каждый контракт имеет владельца из мастер-плана:

- C1 Message Model - SVC-CORE.
- C2 Ingress/Egress - SVC-CORE.
- C3 Backend REST API - SVC-API/SVC-IDN/SVC-CORE по группе эндпоинтов.
- C4 AI Contract - SVC-AI.
- C5 FBP Contract - SVC-FBP.
- C6 Capability Descriptor - SVC-INT.
- C7 WebSocket Events - SVC-CORE/SVC-API.
- C8 Broadcast - SVC-BCAST.
- C9 Edge/App Tunnel - SVC-EDGE.
- C10 Notification - SVC-NOTIF.
- MOBILE.v1 Mobile API - SVC-MOB.
- C-OUT Outbox/Events - SVC-DATA.

Изменение контракта требует участия владельца и затронутых потребителей. Для
контрактов между сервисами ожидаются consumer-driven tests в `tests/contract`.

## SemVer

- `MAJOR` - несовместимое изменение: удаление или переименование поля,
  изменение типа, новое обязательное поле без значения по умолчанию, изменение
  семантики существующего endpoint/event/schema.
- `MINOR` - совместимое расширение: новый необязательный параметр, новая схема,
  новый endpoint или событие без нарушения текущих потребителей.
- `PATCH` - уточнение документации, примеров или метаданных без изменения
  машинно-проверяемого контракта.

Ломающие изменения REST API публикуются через новую версию URL (`/api/v2` и
далее). Существующие версии поддерживаются до согласованного удаления.
