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

## Delivery engine (M4, CP-6)

Этап M4-05 добавляет надёжную массовую доставку через адаптеры (ТЗ §10.8, §10.9,
§11.12). Модуль `src/delivery/` объединяет три механизма:

- **Ретраи и обработка ошибок (§10.8).** `classifyDeliveryError` делит ошибки на
  повторяемые (429, 5xx, 408/425, сетевые коды `ECONNRESET`/`ETIMEDOUT`/… ) и
  постоянные (прочие 4xx, неизвестные). `createBackoffPolicy` даёт
  экспоненциальный бэкофф `delay(n) = min(maxDelayMs, baseDelayMs * factor^(n-1))`
  с опциональным jitter и учётом `Retry-After`. Каждая попытка фиксируется в
  `message_delivery_attempts` через Backend (`createBackendDeliveryClient`,
  контракт `C2.DeliveryAttempt`), что одновременно служит уведомлением ядра.
- **Rate limiting на канал (§10.9).** `createChannelRateLimiter` — token bucket с
  непрерывным пополнением и изоляцией нагрузки между каналами; при исчерпании
  токенов включается backpressure (ожидание пополнения, лимит по `maxWaitMs`).
- **Идемпотентная доставка (§11.12).** Сквозной `idempotency_key` (= `message_id`)
  доходит до внешнего канала; повтор с уже обработанным ключом отбрасывается без
  создания второго внешнего сообщения (двухуровневый dedup: движок + фасад).

Внешний API канала на этом этапе — мок (`createMockExternalChannel`); реальные
внешние сервисы подключаются через тот же фасад доставки (ТЗ §26.3, в CI внешние
API не вызываются).

Endpoint-ы и метрики:

- `POST /internal/delivery/dispatch` — принять C2 Egress и доставить через движок
  (`202` при доставке, `502` при неустранимом отказе, `400` при некорректном
  payload, `503` если движок не сконфигурирован).
- `GET /metrics` дополнительно отдаёт счётчики
  `integration_platform_delivery_*` (`deliveries_total`, `delivered_total`,
  `failed_total`, `duplicate_total`, `retries_total`, `attempts_total`,
  `attempt_record_failures_total`, `queued_total`, `queue_retries_total`,
  `degraded_total`, `timeout_total`, `circuit_open_total`,
  `bulkhead_rejected_total`).

## Delivery resilience (M5, CP-9)

Этап M5-05 добавляет отказоустойчивость доставки при недоступности внешних API
(ТЗ §11.2, §25.4):

- **Timeout на внешний вызов.** Каждый вызов `channel.deliver()` ограничен
  `DELIVERY_TIMEOUT_MS`; timeout классифицируется как retryable деградация,
  фиксируется в `message_delivery_attempts` и метрике
  `integration_platform_delivery_timeout_total`.
- **Circuit breaker на канал.** Ошибки считаются по каждому `channel_type`
  независимо; открытый breaker быстро отклоняет падающий канал, не вызывая
  внешний API повторно до reset window.
- **Bulkhead на канал.** Параллелизм и очередь ожидания ограничены по каждому
  каналу, поэтому зависший Telegram не исчерпывает слоты Email/SMS/VK/… .
- **Async dispatch для ядра.** В production `POST /internal/delivery/dispatch`
  принимает C2 Egress в bounded in-memory queue и сразу возвращает `202 queued`.
  Фоновый worker выполняет доставку/ретраи, а недоставленное остаётся кандидатом
  на повтор; retryable failures не помечаются как окончательно обработанные по
  `idempotency_key`.

Параметры окружения: `DELIVERY_TIMEOUT_MS`,
`DELIVERY_CIRCUIT_FAILURE_THRESHOLD`, `DELIVERY_CIRCUIT_RESET_TIMEOUT_MS`,
`DELIVERY_BULKHEAD_MAX_CONCURRENT`, `DELIVERY_BULKHEAD_MAX_QUEUE`,
`DELIVERY_QUEUE_CONCURRENCY`, `DELIVERY_QUEUE_MAX_SIZE`,
`DELIVERY_QUEUE_MAX_ATTEMPTS`, `DELIVERY_QUEUE_RETRY_DELAY_MS`.

Проверки M5: unit `test/unit/m5-delivery-resilience.test.mjs`, integration
`test/integration/m5-delivery-degradation.integration.test.mjs`, e2e
`tests/e2e/integration-degradation-cp9.test.mjs`.

Вне области SVC-INT: генерация кампаний остаётся в SVC-BCAST; персистентная
очередь доставки может заменить in-memory queue без изменения C2-контракта.
