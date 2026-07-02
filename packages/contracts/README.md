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

## M0-13: C7/C9 для Edge & WebSocket Gateway

- `openapi/edge/c7.websocket.openapi.json` фиксирует C7 `GET /ws` как WebSocket
  upgrade и семантику авто-reconnect через cursor `last_event_id`.
- `events/c7-websocket-event.schema.json` фиксирует общий envelope C7 v1:
  `event_id`, `organization_id`, `sequence_number`, `payload`, `occurred_at` и
  события `message.created`, `message.status_changed`, `typing.started`,
  `typing.stopped`, `client.status_changed`, `notification.created`,
  `broadcast.state_changed`, `workflow.state_changed`.
- `openapi/edge/c9.edge-tunnel.openapi.json` фиксирует EDGE→CORE tunnel endpoint
  `POST /internal/edge/tunnel/messages`.
- `json-schema/c9-edge-tunnel-message.schema.json` фиксирует C9 v1 envelope с
  `sequence_number`, `idempotency_key`, `endpoint_id`, C1 `payload` и
  timestamps `received_at`, `buffered_at`, `forwarded_at`.
- `src/c7.mjs` и `src/c9.mjs` содержат M0-константы и лёгкие валидаторы для unit
  и contract smoke-тестов.

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
