# Кнопка «Проверить подключение»: что и насколько реально проверяется

Документ отвечает на вопрос из issue [#263](https://github.com/rumaster/bridge/issues/263):
что именно проверяет кнопка **«Проверить подключение»** (Test connection) в SaaS Admin
для каждого типа канала и насколько эта проверка «реальна» — то есть отражает ли
она фактическую работоспособность интеграции, а не просто наличие записи в БД.

## Где живёт логика

- **UI**: `apps/saas-admin/src/presentation/pages/ChannelsPage.tsx` — кнопка вызывает
  `api.channels.testChannel(channelId)`.
- **HTTP-контракт**: `POST /channels/{id}:test` →
  `services/backend/src/modules/integration-gateway/channels.controller.ts`
  (`ChannelTestController`).
- **Ядро проверки**: `IntegrationGatewayFacade.testChannel(...)` в
  `services/backend/src/modules/integration-gateway/integration-gateway.facade.ts`.
  Он диспетчеризует вызов по `channel_type`.

Каждая проверка сохраняет результат в БД через `persistChannelCheck(...)`:
обновляются `status` (`connected` / `error`) и `last_check_at`, а для мессенджеров —
ещё и `config` (`bot_id`, `bot_username`). Результат ответа:
`{ accepted, channel_id, status, checked_at, error? }`.

## Сводка по типам каналов

| Тип канала | Что делает проверка | Насколько реальна |
| --- | --- | --- |
| **Telegram** | Резолвит токен бота и вызывает `GET /bot<token>/getMe` Telegram Bot API | **Реальная**: живой запрос к провайдеру, валидирует токен, сохраняет `bot_id`/`bot_username`. Невалидный/отсутствующий токен → `error` с причиной |
| **MAX** (наследие TamTam) | Резолвит токен и вызывает `GET {MAX_API_BASE_URL}/me?access_token=…` | **Реальная**: живой запрос к MAX Bot API, сохраняет `bot_id`/`bot_username`. Ошибка провайдера → `error` |
| **Email** | Через Edge control-plane (`channel_test` на `EDGE_CONTROL_URL`) выполняет реальный **IMAP LOGIN + SMTP verify** на Edge Gateway (РФ-контур) | **Реальная (условно)**: проверка выполняется там же, где идёт приём/отправка. Если `EDGE_CONTROL_URL`/`EDGE_CONTROL_TUNNEL_URL` не настроен — честный `error`, а не ложный `connected` |
| **Web Chat** | При наличии upstream (`INTEGRATION_GATEWAY_URL`) — только запрос capabilities; без upstream — безусловно `connected` | **Нереальная (заглушка)**: фактическая связность (валидность `credentials_ref`, доступность `widget_origin`) не проверяется |
| Прочие типы без upstream | Ветка по умолчанию: безусловный `connected` | **Нереальная**: только фиксирует статус в БД |

## Детали по каждому типу

### Telegram — реальная проверка

`testTelegramChannel(...)`:

1. Резолвит токен из `credentials_envelope` по `credentials_ref`. Если токена нет →
   `status = error`, `error = "Токен Telegram-бота не настроен для канала."`.
2. Вызывает `runTelegramGetMe(token)` → `GET {telegramApiBaseUrl}/bot<token>/getMe`.
3. `ok === true` → `status = connected`, в `config` пишутся `bot_username` и `bot_id`.
   Иначе `status = error` с `description` от Telegram (или обобщённой причиной, если
   API недоступен).

Вывод: это честная проверка того, что токен валиден и бот доступен через Telegram
Bot API. Она **не** проверяет настройку вебхука/поллинга приёма сообщений — только
идентичность бота.

### MAX — реальная проверка

`testMaxChannel(...)` полностью симметричен Telegram, но зовёт `runMaxGetMe(token)` →
`GET {maxApiBaseUrl}/me?access_token=<token>` (токен в query по контракту провайдера,
URL не логируется). Успех определяется наличием `user_id` в ответе. Сохраняет
`bot_id`/`bot_username`. Те же оговорки, что и для Telegram: проверяется идентичность
бота, а не полный маршрут приёма сообщений.

### Email — реальная проверка через Edge

`testEmailChannel(...)`:

1. Резолвит структурные IMAP/SMTP-креды. Нет кред → `error`.
2. Если не настроен `EDGE_CONTROL_URL`/`EDGE_CONTROL_TUNNEL_URL` → `error`
   («Проверка email недоступна…»), потому что IMAP/SMTP по архитектуре живут на Edge
   (РФ-контур) и проверять их из backend нельзя.
3. Иначе `publishChannelTest(...)` шлёт `C9.EdgeControlMessage` с `type=channel_test`
   и кредами **объектом** в payload на Edge. Edge выполняет реальный **IMAP LOGIN +
   SMTP verify** и возвращает синхронный ack `connected` / `error`+причина.

Важное свойство: неверные креды (обычный пароль вместо app-password, закрытый порт,
недоступный хост) дают **честный `error`**, а не обобщённый `connected`. Любой сбой
связи с Edge → тоже `error`. Ложноположительного результата здесь нет.

### Web Chat и прочие типы — заглушка

Для Web Chat отдельной ветки нет:

- Если настроен upstream (`INTEGRATION_GATEWAY_URL`), выполняется
  `testUpstreamChannel(...)` — но при отсутствии у upstream метода `testChannel`
  делается лишь **lookup capabilities**; сам HTTP-клиент upstream в `testChannel`
  тоже сначала запрашивает capabilities и затем **безусловно** возвращает
  `status: "connected"`.
- Если upstream не настроен, срабатывает ветка по умолчанию в
  `IntegrationGatewayFacade.testChannel(...)`, которая **всегда** возвращает
  `connected`.

Итог: для Web Chat кнопка подтверждает лишь, что запись канала существует (и, при
upstream, что интеграционный шлюз отвечает на capabilities). Валидность
`credentials_ref` и доступность `widget_origin` не проверяются. Это следует
воспринимать как заглушку, а не как реальную проверку связности.

## Что проверка НЕ делает (общие ограничения)

- Для мессенджеров проверяется идентичность бота (`getMe`/`/me`), но **не** сквозной
  маршрут доставки входящих сообщений (вебхук/поллинг, маршрутизация в ядро).
- Для Email проверяется вход IMAP и готовность SMTP, но **не** сквозная доставка
  письма конкретному получателю.
- Для Web Chat реальной проверки связности нет вовсе.

## Возможные улучшения (follow-up)

1. Сделать проверку Web Chat реальной: валидировать `credentials_ref` и, при
   наличии, доступность `widget_origin` (например, HEAD-проба), иначе возвращать
   `error` вместо безусловного `connected`.
2. Явно помечать в UI «нереальные» проверки (заглушки), чтобы оператор понимал
   разницу между «канал существует» и «канал работает».

## Источники в коде

- `services/backend/src/modules/integration-gateway/integration-gateway.facade.ts`
  (`testChannel`, `testTelegramChannel`, `runTelegramGetMe`, `testMaxChannel`,
  `runMaxGetMe`, `testEmailChannel`, `publishChannelTest`, `testUpstreamChannel`).
- `services/backend/src/modules/integration-gateway/integration-gateway.upstream.ts`
  (`testChannel` HTTP-upstream).
- `services/backend/src/modules/integration-gateway/channels.controller.ts`
  (`ChannelTestController`).
- `apps/saas-admin/src/presentation/pages/ChannelsPage.tsx` (кнопка и обработка
  результата).
