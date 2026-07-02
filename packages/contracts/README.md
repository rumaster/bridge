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
