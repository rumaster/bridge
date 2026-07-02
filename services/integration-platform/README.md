# Integration Platform M0-05

Этап M0-05 фиксирует потребление C2, C6 Capability Descriptor и мок адаптера без
реальных внешних каналов.

## C2 consumption

- Adapter публикует входящие сообщения в ядро через
  `POST /internal/ingress/messages`.
- Adapter принимает исходящую доставку от ядра через
  `POST /internal/egress/deliveries`.
- M0-схемы лежат в `packages/contracts/json-schema/`, обзор endpoint-ов - в
  `packages/contracts/openapi/c2-internal-api.yaml`.

## Mock adapter

Каркас сервиса экспортирует:

- `GET /health` - health-check сервиса.
- `GET /metrics` - Prometheus-compatible счётчики mock adapter.
- `GET /mock/capabilities` - C6 descriptor mock-канала.
- `POST /mock/incoming/messages` - эмуляция входящего сообщения и публикация C2
  Ingress в mock/core.
- `POST /internal/egress/deliveries` - приём C2 Egress и запись доставки в
  channel stub.

Mock adapter поддерживает весь C6 v1 набор возможностей: `text`, `image`, `file`,
`voice`, `video`, `buttons`, `reactions`, `typing_indicator`, `read_receipt`,
`delete`, `edit`.
