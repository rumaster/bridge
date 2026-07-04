# SVC-MOB M5 acceptance notes

Дата локальной проверки: 2026-07-04.

## Команды

```sh
npm test --workspace @bridge/mobile-api
node --test packages/contracts/test/unit/mobile-contract.test.mjs tests/contract/mobile-api-contract.test.mjs
```

## Независимое версионирование

- Текущая minor-версия MOBILE.v1: `1.1.0`.
- Ранее опубликованная версия клиента: `1.0.0`.
- `packages/contracts/src/mobile.mjs`, OpenAPI `x-supported-versions` и
  `packages/contracts/mobile/consumer-contracts.v1.json` фиксируют поддержку обеих
  версий.
- DTO-валидация `services/mobile-api/src/mobile-dto.mjs` принимает запросы
  `1.0.0` и `1.1.0`, но отклоняет несовместимый major `2.0.0`.

## Производительность агрегированных вызовов

Замеры из интеграционного пробника `SVC-MOB BFF integration - latency budgets (§25.2)`
на локальном in-memory backend:

| Вызов | Бюджет | Замер |
|---|---:|---:|
| `GET /mobile/v1/dialogs` | <= 1000 ms | 16.7 ms |
| `GET /mobile/v1/dialogs/{id}/messages` | <= 2000 ms | 8.3 ms |
| `GET /mobile/v1/notifications` | <= 1000 ms | 2.7 ms |

## Устойчивость sync и push

- Частичный `GET /mobile/v1/sync?limit=...` строит dialog preview только до
  watermark текущей страницы, чтобы не ссылаться на дельты, ещё не доставленные
  клиенту.
- Повторный sync по старому курсору остаётся стабильным чтением, а новый курсор
  не откатывается.
- Push fallback покрыт интеграционно: transient-сбой мок-провайдера ретраится до
  доставки, dead token деактивируется и исключается из последующей адресации.
