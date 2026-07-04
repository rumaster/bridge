# Communication Core M5: нагрузочные пробники и деградация

Документ фиксирует эксплуатационный контур M5 для SVC-CORE: пробники не вводят
новые route/message-типы и работают поверх существующего C2 ingress-пути.

## Пробник приёма/маршрутизации

В production NestJS путь подключён через `CommunicationCoreLoadProbeService`:
обычный ingress обновляет counters/latency, а `/metrics` экспортирует
`bridge_backend_communication_core_ingress_*`. Compatibility factory
`createCommunicationCoreLoadProbe` в `communication-core/index.mjs` сохраняет
старые `.mjs` регрессии и принимает массив C2 `IngressMessage` с ограничением
параллелизма. Результат содержит:

- `total`, `accepted`, `duplicates`, `failed`;
- `concurrency`, `peak_in_flight`;
- `duration_ms`, `throughput_per_second`;
- `latency_ms.min/avg/p50/p95/p99/max`;
- первые `sample_results` для быстрой сверки маршрутизации.

Локальная CP-9 фикстура проверяет 24 сообщения при `concurrency=6`; unit-фикстура
проверяет 12 сообщений при `concurrency=4`. Эти числа не являются SLA из ТЗ
§25.11, а дают повторяемую регрессию, что ядро принимает нагрузочную партию,
сохраняет idempotency и возвращает измеримый отчёт.

## Деградация адаптеров

Production egress использует `AdapterFailureCoordinator`; compatibility factory
`createAdapterFailureCoordinator` сохранена в `communication-core/index.mjs` для
старых `.mjs` тестов. Координатор ограничивает каждый вызов адаптера таймаутом и
конечным числом попыток. Промежуточные неуспешные попытки записываются в
`message_delivery_attempts`; финальная неуспешная попытка переводит сообщение из
`routed` в `failed`. Ошибка адаптера не блокирует приём сообщений из другого
канала.

## Деградация AI

Production AI path использует `AiDegradationGuard`; compatibility factory
`createAiDegradationGuard` сохранена в `communication-core/index.mjs`.
Guard изолирует SVC-AI как вспомогательную подсистему:
отсутствующий клиент, ошибка или timeout возвращают структурированный degraded
fallback, а Communication Core продолжает приём и маршрутизацию сообщений.

## Multi-instance PostgreSQL

Для общей модели данных M5 добавлена повторная проверка idempotency после
`endpoint`-lock. Это закрывает гонку, где два экземпляра успевали прочитать
отсутствующее сообщение до блокировки и затем конкурировали за один
`idempotency_key`. Integration-тест запускает несколько клиентов PostgreSQL и
проверяет, что конкурентный приём не создаёт дублей, а `sequence_number` остаётся
монотонным.
