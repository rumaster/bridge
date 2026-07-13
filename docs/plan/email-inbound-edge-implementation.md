---
title: Приём входящей почты через Edge Gateway — актуализация и остаточный разрыв
service_id: SVC-EDGE · SVC-API
status: Актуализировано 2026-07-13
language: ru-RU
based_on: docs/plan/email-channel-production.md, docs/plan/mail-service-selfhosted.md
date: 2026-07-13
---

# Приём входящей почты через Edge — актуализация (HEAD 277ba0f)

> **Важно.** Первоначальный план этого документа (реальный IMAP-клиент → туннельный
> pull-RPC → wiring драйвера → деплой) **в значительной части реализован** отдельной
> веткой работ «Bridge Mail» (M1–M5) и правкой egress, но **другим способом**, чем
> здесь предлагалось (push по HTTP, а не pull по туннелю). Документ переписан под
> фактическое состояние и единственный оставшийся разрыв.

## Что уже сделано (проверено по коду и на стенде)

- **Реальный IMAP-клиент** — [`edge-imap-mailbox.ts`](../../services/edge-gateway/src/edge-imap-mailbox.ts)
  (`imapflow`, poll по курсору UID, MIME→`RawEmail`, история не импортируется).
- **Реальный SMTP-транспорт** — [`edge-smtp-transport.ts`](../../services/edge-gateway/src/edge-smtp-transport.ts)
  (`nodemailer` за сеамом `createTransport`).
- **Wiring входящего+исходящего драйверов** — [`edge-channel-drivers.ts`](../../services/edge-gateway/src/edge-channel-drivers.ts)
  (`createEdgeChannelRuntime`), подключён в [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts)
  за гейтом `EDGE_CHANNEL_DRIVERS=on` (на стенде — on). Реестр каналов и креды —
  из control-plane ([`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts),
  `listChannels`/`getEmailCredentials`, ключевание по `channel_id`).
- **Приёмник control-plane на Edge** — `POST /internal/edge/control/messages`
  ([`server.ts`](../../services/edge-gateway/src/server.ts)) → `controlPlane.handle`
  (`channel_credentials_sync` → `storeCredentials`; `egress_dispatch` → `dispatchEgress`).
- **Backend-egress** — [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)
  `forwardEgressToEdgeControl`: для `channel_type=email` POST `egress_dispatch` на
  `EDGE_CONTROL_URL` (коммит `e65de03`). Транспорт — HTTP, не туннель.
- **Self-hosted почтовик** — `mailserver` (docker-mailserver) + провижининг
  ([`mail-provision.ts`](../../scripts/mail-provision.ts)) + заказ из админки (M5).
- **Стенд:** `EDGE_CHANNEL_DRIVERS=on`, канал «Bridge Mail (support@lissac-games.online)»
  подключён; сквозной путь подтверждён (3 inbound + 3 outbound email в `messages`).

## Остаточный разрыв — единственный, но блокирующий

**На стороне backend/App НЕТ публикатора `channel_credentials_sync`.** Креды каналов
никогда не доходят до Edge в штатной работе — `edge-control-plane.storeCredentials`
наполняется только вручную скриптом [`verify-full-path.ts`](../../services/edge-gateway/scripts/verify-full-path.ts),
который играет роль App-стороны. Следствие (проверено на стенде):

- лог edge-gateway: `Edge email inbound driver started { channels: 0 }` →
  входящий IMAP **ничего не поллит**, **менеджер не получает входящих писем**;
- `egress_dispatch` (ответ менеджера) падает с «No SMTP credentials», т.к. те же
  креды берутся из того же пустого кэша.

`edge-control-client.ts`/`edge-control-tunnel.ts` (App-клиент creds-sync) импортируются
**только тестами**. Реальный сокет VPN-туннеля App→Edge control-плоскости не несёт —
её роль выполняет прямой HTTP (`EDGE_CONTROL_URL`).

## План закрытия (backend-only, малый объём)

### Ш1 — Публикация creds-sync при изменении канала (push-on-write) — ✅ РЕАЛИЗОВАНО

> **Статус: реализовано** (backend). `IntegrationGatewayFacade.publishChannelCredentialsSync`
> ([`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts))
> вызывается из `connectChannel` (после INSERT) и `updateChannel` (при ротации email-кред):
> при заданном `EDGE_CONTROL_URL` POST'ит `C9.EdgeControlMessage{type:channel_credentials_sync,
> payload:{channel_id, channel_type, credentials:<объект>, config}}` (control_id
> `creds-<channel_id>-<issued_at>`). Best-effort — недоступность Edge не ломает
> connect/update. Тесты (jest)
> [`integration-gateway.facade.spec.ts`](../../services/backend/test/unit/integration-gateway.facade.spec.ts):
> публикация при подключении email, best-effort при недоступности, no-op без
> `EDGE_CONTROL_URL`. `tsc` зелёный; facade-спека 13/13.
>
> Осталось для полного контура: **Ш2** (bulk-resync после рестарта Edge — сейчас
> существующие каналы не пере-синхронизируются, пока не будет connect/update) и
> деплой backend на стенд + сквозная проверка (**Ш3**).

Оригинальное описание шага:
В [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
`connectChannel`/`updateChannel` для `channel_type=email`: при заданном
`EDGE_CONTROL_URL` собрать `C9.EdgeControlMessage {type:"channel_credentials_sync"}`
и POST на `EDGE_CONTROL_URL` (переиспользовать литерал-конверт и fetch-обвязку из
`forwardEgressToEdgeControl`). Плейнтекст структурных кред уже в scope перед
шифрованием (`resolveSecretPlaintext`). Payload — `{channel_id, channel_type,
organization_id, config, credentials: <объект EmailChannelCredentials>}` (именно
**объект**, не сериализованная строка — валидатор control-plane и `storeCredentials`
ждут объект). `control_id` — стабильный (напр. `creds-<channel_id>-<updated_at>`) для
идемпотентности. Мультиканальность обеспечена: `storeCredentials`/`listChannels`
ключуют по `channel_id`.

### Ш2 — Bulk-resync (кэш Edge in-memory, теряется при рестарте) — ✅ РЕАЛИЗОВАНО

> **Статус: реализовано** (backend). `IntegrationGatewayFacade.resyncEmailChannelCredentials`
> проталкивает креды ВСЕХ `connected` email-каналов на Edge; запускается по таймеру
> (`onApplicationBootstrap` → `setInterval`, интервал `EDGE_CREDENTIALS_RESYNC_INTERVAL_MS`,
> дефолт 60с; сразу один прогон на старте), гейт — `EDGE_CONTROL_URL`. Резолв кред
> **по `channel_id`** через новый `listConnectedEmailChannelsForSync` (кросс-тенантный
> `SELECT … channel_type='email' AND status='connected'`) + `resolveChannelSecret` на
> каждый канал — не `LIMIT 1`, поэтому у организации может быть несколько ящиков.
> `control_id` стабилен по `updated_at` (общий с Ш1): пока кэш Edge жив — дедуп, после
> рестарта Edge — повторное сохранение (кэш обработанных id тоже обнулён). Best-effort
> по каналу. Тесты (jest): per-channel push двух каналов + no-op без `EDGE_CONTROL_URL`
> (facade 15/15). Env добавлен в `.env.example` и `docker-compose.yml` (backend).

Исходное описание шага:
Push-on-write не покрывает рестарт Edge и «холодный» Edge. Нужен периодический/по-
событию bulk-push всех `connected` email-каналов: backend берёт список
(`listActiveChannelsByType("email")`) и per-channel креды и шлёт creds-sync на каждый.
**Важно:** резолв кред per-channel — сейчас `resolveChannelDeliveryToken(org,type)`
берёт `LIMIT 1` (схлопывает несколько email-каналов организации). Для bulk-resync
нужен резолв **по `channel_id`** (расширить facade/эндпоинт) — иначе второй ящик
организации получит чужие/один креды. (Для Ш1 это не нужно — там креды берутся прямо
из тела запроса.)

### Ш3 — Верификация на стенде
После Ш1: подключить/переподключить email-канал → в логах edge-gateway
`channels: 1`, входящее письмо на `support@…` доходит до `messages`/менеджера **без**
`verify-full-path.ts`. После Ш2: рестарт edge-gateway → канал восстанавливается в
реестре сам.

## Вне scope этого разрыва (отдельные вехи)
- **Боевая deliverability (M3):** порт 25, PTR, публикация DNS, TLS —
  [`mail-service-selfhosted.md`](./mail-service-selfhosted.md) §M3.
- **Реальный TCP/TLS-сокет VPN-туннеля (MP-12/MP-22)** и перенос control-plane с
  прямого HTTP на туннель.
- **Вложения → `storage_ref`** (S3 отложен).
