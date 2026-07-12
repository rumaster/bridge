---
title: Реализация приёма входящей почты через Edge Gateway (MP-12, входящее направление)
service_id: SVC-EDGE · SVC-API
status: In progress
language: ru-RU
based_on: docs/plan/email-channel-production.md
date: 2026-07-12
---

# Приём входящей почты через Edge Gateway — план реализации

Довести входящее направление email до реально работающего на стенде: письмо
клиента забирается по IMAP **на RF Edge Gateway**, RF-first приземляется в
буфере, идёт через VPN-туннель в ядро и попадает в диалог менеджера с каналом
`email`. Закрывает разрыв «канал создан, но ящик никто не читает».

## Границы
- **В scope:** входящее (IMAP → RF-буфер → туннель → ядро → менеджер).
- **Вне scope (отдельный follow-up):** ответ менеджера → SMTP на Edge (E4:
  `handoffEgress` → `egress_dispatch` → `edge-email-sender`).

## Ключевое решение: PULL, а не PUSH
Вместо server-initiated `channel_credentials_sync` (App→Edge push, требует нового
направления туннеля — самая рискованная часть E2) Edge **сам вытягивает** список
каналов и креды новым request/response RPC `email_sync_pull` по уже существующему
Edge→App направлению. App-сторона отвечает, проксируя в **существующие** S2S
backend-эндпоинты. Креды на Edge живут только в памяти. Свежесть — по интервалу
refresh драйвера.

## Мультиканальность (пункты 1–3, вложены в этапы)
Юнит изоляции — **канал** (`channels.id`), не организация: у одной организации
может быть несколько email-ящиков, плюс много организаций. Драйвер
[`edge-email-inbound-driver.ts`](../../services/edge-gateway/src/edge-email-inbound-driver.ts)
уже per-channel (свой цикл/курсор/`seen`/ящик, изоляция сбоев, add/remove через
`refreshChannels`). Закрываем три стыка:

- **(1) Ключевание кредов по `channelId`, не по `(org, type)`.** Сейчас
  `GET /internal/channels/secret` берёт `organization_id + channel_type`, а
  `resolveChannelDeliveryToken` — `LIMIT 1`: два email-канала одной организации
  схлопываются в один секрет. Правка backend: резолв секрета **по `channel_id`**
  (новый параметр эндпоинта + метод фасада по id). Pull-payload отдаёт
  `credentials: {[channelId]: EmailChannelCredentials}`. → **Этап 2.**
- **(2) Инвалидация ящика при ротации кредов.** `getMailbox` кэширует
  `EdgeMailbox` по channelId и не пересоздаёт при смене пароля. Правка: версия
  кредов (хеш/`updated_at`) → при изменении закрыть и пересоздать ящик. → **Этап 3.**
- **(3) Долговечность курсора/дедупа.** `cursorUid`/`seen` — в памяти, теряются
  при рестарте; корректность спасает сквозной `idempotency_key`
  (`stableEmailMessageId`), но батч перекачивается. Правка (эффективность):
  персистить per-channel UID-курсор в RF-postgres. → **follow-up** (не блокирует).

Масштабирование ресурсов: poll (не IDLE) на старте; cap параллелизма + jitter
старта циклов (лимиты провайдера); переиспользование соединения в канале;
per-channel метрики в лог.

## Этапы

### Этап 1 — Реальный IMAP-клиент (изолированно)
- Зависимости `edge-gateway`: `imapflow` + `mailparser`.
- `services/edge-gateway/src/edge-imap-mailbox.ts`: `createImapMailbox({credentials, channel})`
  → `EdgeMailbox.fetchNew({sinceUid})` → `RawEmail[]` (форма из
  [`edge-email-ingress.ts`](../../services/edge-gateway/src/edge-email-ingress.ts)).
  Клиент инъектируется в composition root (тесты — на заглушках).
- Тест: маппинг MIME→RawEmail на фикстурах.
- **Гейт (ранний):** из edge-контейнера реальный коннект к `imap.gmail.com:993`
  (сначала TCP/TLS-достижимость без кредов, затем LOGIN реальными кредами канала).

### Этап 2 — Туннельный pull-RPC кредов/каналов (по channelId)
- Новый RPC `email_sync_pull` в
  [`vpn-transport.ts`](../../services/edge-gateway/src/vpn-transport.ts) (аддитивно
  к `handshake`/`deliver`). Ответ: `{channels:[{channel_id, organization_id, config}],
  credentials:{[channelId]: EmailChannelCredentials}}`.
- App-сторона (`startAppVpnRuntime`): обработчик вызывает backend S2S
  (`GET /internal/channels?channel_type=email` + секрет **по channel_id**),
  парсит `parseEmailChannelCredentials`. Env `EDGE_VPN_BACKEND_S2S_URL`.
- Backend (пункт 1): `GET /internal/channels/secret?channel_id=…` + резолв по id.
- Edge-сторона: `pullEmailSync()`.
- Тесты: App-handler с моком fetch; round-trip Edge↔App.

### Этап 3 — Wiring драйвера в `edge-runtime` (mode=edge)
- В `createEdgeGatewayRuntimeFromEnv` после сборки `cluster`: собрать
  `createEdgeEmailInboundDriver({ listChannels, resolveCredentials, createMailbox,
  ingest: cluster.ingest })` из pull-кэша; `start()` на буте, `stop()` в `close`.
- Пункт 2: инвалидация ящика по версии кредов.
- Env: `EMAIL_INBOUND_ENABLED`, `EMAIL_INBOUND_POLL_INTERVAL_MS`,
  `EMAIL_INBOUND_REFRESH_INTERVAL_MS`, cap параллелизма, jitter.
- Тест: письмо → `messages` ядра → канал `email` в manager-workspace.

### Этап 4 — Деплой и сквозная проверка
- Пересобрать `edge-gateway` (RF) + `edge-vpn-app`, пересоздать.
- Письмо на ящик → подтвердить в БД и UI менеджера; идемпотентность; RF-first.

## Риски
- Достижимость Gmail IMAP из RF-контейнера (egress :993) — проверяется первым.
- Валидность gmail app-password / включён ли IMAP.
- RPC-поверхность туннеля — строго аддитивно.
- Новая зависимость `imapflow` в RF-компоненте.
- На стенде `EDGE_VPN_APP_CRYPTO=off` — креды по туннелю защищены только
  AmneziaWG (для стенда ок; для прода — отметить).
