# SVC-MOB — Mobile API BFF (M4-14)

**BFF (Backend-for-Frontend)** для мобильных приложений менеджера (ТЗ §19):
специализированное представление Backend API, которое **агрегирует** вызовы ядра
под мобильные экраны, обеспечивает **оффлайн-синхронизацию** (дельты/курсоры),
**идемпотентную отправку** сообщений, доставку **push** (FCM/APNs) и **realtime**
по WebSocket (C7). Клиенты РФ подключаются через **Edge Cluster** (C9/SVC-EDGE,
ТЗ §19.5, §7.6). SVC-MOB **не реализует бизнес-логику** (ТЗ §19.1) — вся логика
живёт в ядре, а BFF лишь **проксирует и переупаковывает** данные. SVC-MOB
участвует в **CP-7** (мастер §6).

Веха **M4-14** — ОСНОВНАЯ работа сервиса (мастер §5.1): поверх замороженного
детерминированного M0-мока добавлен работающий мобильный BFF с шестью механизмами
(агрегация, дельта-синхронизация, идемпотентная отправка, push, realtime C7,
подключение РФ через Edge).

## Слои

- `src/backend-client.ts` — мок Backend API (канал C3.\*): разговоры, сообщения,
  уведомления C10, приём канонических сообщений от Edge (`ingestEdgeBatch`) и
  проекция C7-событий; монотонная лента изменений на организацию
  (`getChangesSince`, `sequence_number` §7.10), дедуп по `idempotency_key` (§11.12).
- `src/aggregators.ts` — сборка «экранных» DTO (диалоги с превью/счётчиками,
  история, уведомления) из вызовов C3.\* → компактные мобильные DTO (ТЗ §19.2).
- `src/sync-engine.ts` + `src/sync-cursor.ts` — дельта-синхронизация
  `GET /mobile/v1/sync`: изменения после курсора + новый курсор; курсор
  `mob1.<base64url-json>` монотонен, устойчив к «оффлайн → онлайн» без потерь и
  дублей (ТЗ §19.3).
- `src/device-registry.ts` — реестр устройств/push-токенов и онлайн-присутствия
  (для fallback «нет WS → push»); отзыв и деактивация мёртвых токенов (ТЗ §19.4).
- `src/push-payload.ts` + `src/push-provider.ts` + `src/push-dispatcher.ts` —
  маппинг C10 → payload FCM/APNs, мок-провайдер (ретраи, transient/dead-токены) и
  диспетчер доставки с деактивацией мёртвых токенов (ТЗ §19.4, §15.4).
- `src/realtime-consumer.ts` — потребление C7-событий (`message.created`,
  `message.status_changed`, `notification.created`, `typing.*`), дедуп по
  `event_id`, доставка по WS либо fallback в push при отсутствии живого WS.
- `src/mobile-bff.ts` — прикладной фасад `createMobileBff`, связывающий слои и
  экспонирующий методы для HTTP-сервера, Edge-приёма и realtime.
- `src/mobile-dto.ts` — валидация входных DTO мобильного контракта (MOBILE.v1).

> `src/server.ts`, `src/deterministic-mobile-api.ts`, `src/main.ts` — HTTP-слой
> и замороженный детерминированный M0-мок (wire-контракт). Реальный BFF (M4)
> подключается в `server.ts` через параметр `mobileApi`; `MOBILE_API_MODE=mock`
> откатывает `main.ts` на M0-мок.

## Публичный API

```js
import { createMobileBff } from "./src/mobile-bff.ts";
import { createMobileApiServer } from "./src/server.ts";

// BFF со всеми слоями; now — инъектируемые часы (детерминизм, без ГСЧ/времени).
const bff = createMobileBff({ now, context: { organizationId, userId, deviceId } });
const server = createMobileApiServer({ mobileApi: bff });

// Агрегированные «экранные» эндпоинты (ТЗ §19.2):
//   GET  /mobile/v1/dialogs
//   GET  /mobile/v1/dialogs/{dialogId}/messages
//   GET  /mobile/v1/notifications
// Оффлайн-синхронизация на дельтах/курсорах (ТЗ §19.3):
//   GET  /mobile/v1/sync?device_id=...&cursor=mob1.<...>
// Идемпотентная отправка, idempotency_key = message_id (ТЗ §11.12):
//   POST /mobile/v1/messages
// Регистрация/отзыв устройства и push-токена (ТЗ §19.4):
//   POST /mobile/v1/devices
//   DELETE /mobile/v1/devices/{deviceId}
```

## Оффлайн-синхронизация (дельты/курсоры, §19.3)

`GET /mobile/v1/sync` отдаёт изменения после курсора и новый курсор. Курсор
`mob1.<base64url-json>` несёт `{ v, organization_id, user_id, device_id, sequence,
issued_at }` и монотонен относительно per-organization change-feed (`sequence_number`
§7.10). Повторный sync по старому курсору отдаёт тот же срез (стабильное чтение),
sync по новому — пусто; так гарантируется устойчивость «оффлайн → онлайн» без
потерь и без дублей.

## Идемпотентная отправка (§11.12)

`POST /mobile/v1/messages` проксирует сообщение в C3.messages со сквозным
`idempotency_key = message_id`. Первый вызов принимается (`duplicate: false`),
повтор дедуплицируется (`duplicate: true`) без нового `sequence_number` — счётчик
`mobile_api_messages_dedup_total` растёт.

## Push и fallback «нет WS → push» (§19.4, §15.4)

`POST /mobile/v1/devices` регистрирует устройство/токен (FCM/APNs). При
`notification.created` (C10) и отсутствии живого WS у получателя BFF ретранслирует
уведомление в push через мок-провайдер, а клиент затем догоняет ленту через
`GET /sync`. Провайдер моделирует transient-сбои (ретраи) и dead-токены —
последние деактивируются в реестре и исключаются из адресации.

## Realtime C7 и подключение РФ через Edge (CP-7, §19.5/§7.6)

`bff.connectRealtime(...)` подписывается на C7-события через WS-канал: реплей
пропущенного по `lastEventId` при реконнекте, дедуп по `event_id`. Клиент РФ
подключается через **Edge**: `bff.ingestEdgeBatch(messages)` принимает канонические
сообщения, выгруженные из буфера Edge при восстановлении связи. Консистентность при
разрыве обеспечивает Edge (буфер §7.9, порядок §7.10, дедуп §11.12), а BFF
восстанавливает порядок по `sequence_number` и повторно дедуплицирует при выгрузке —
без потерь, дублей и перестановок в рамках Endpoint.

## Тесты

```sh
npm test --workspace @bridge/mobile-api   # unit + integration сервиса
npm run test:e2e                           # CP-7: «Потеря соединения» + мобильный realtime
```

- **unit** — агрегаторы (C3.\* → «экранный» DTO), логика дельт/курсоров
  (монотонность, нет потерь/дублей), маппинг push (C10 → FCM/APNs), реестр
  устройств, диспетчер push (ретраи/деактивация), realtime-consumer (дедуп/fallback).
- **integration** — против мок-Backend/мок-WS (ТЗ §26.4): оффлайн → онлайн
  синхронизация, доставка push через мок-провайдер, `POST /messages` с
  дедупликацией, бюджеты латентности (диалоги ≤ 1 с, история ≤ 2 с,
  уведомления ≤ 1 с, ТЗ §25.2).
- **e2e** — `tests/e2e/mobile-connection-loss-cp7.test.ts` (CP-7, ТЗ §26.6):
  клиент РФ через Edge — разрыв → восстановление → синхронизация без потерь/дублей
  и без нарушения порядка; мобильный realtime — реконнект WS C7 с реплеем без
  потерь и дублей, `GET /sync` доотдаёт накопленное.
