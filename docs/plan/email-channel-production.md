---
title: План доведения канала Email до боевого режима
service: Edge Gateway / Integration Platform / Backend / SaaS Administration
service_id: SVC-EDGE · SVC-INT · SVC-API · SVC-ADMIN
version: 2.0
status: Draft
language: ru-RU
based_on: docs/plan/mock-to-production.md, docs/plan/telegram-channel-production.md, docs/plan/services/05-integration-platform.md
date: 2026-07-11
decisions:
  - "IMAP/SMTP исполняются на Edge Gateway (РФ-контур), не на SVC-INT/app-стороне."
  - "Бизнес-клиент — роль administrator в SaaS Administration, добавляет каналы на странице :8081/channels."
---

# План доведения канала Email до боевого режима

Документ детализирует конкретные шаги, чтобы **сквозной боевой сценарий Email**
работал без моков и разрывов:

- бизнес-клиент (роль **administrator** в SaaS Administration) добавляет
  **креды почты своей организации** (IMAP + SMTP) на странице `:8081/channels`;
- менеджер **принимает входящие письма и отвечает** клиенту из
  manager-workspace;
- на всех этапах работает доставка **«клиент ↔ edge ↔ app ↔ manager»** и
  обратно;
- **IMAP и SMTP работают на Edge Gateway** (РФ-контур) — не на app-стороне.

## Принятые решения (закрывают открытые вопросы v1.0)

1. **Размещение IMAP/SMTP — Edge Gateway.** Обоснование: главная задача
   проекта — обеспечить через VPN-туннель Edge↔App стабильную связь в
   условиях нестабильного/блокируемого интернета в РФ. Приём и отправка
   почты — часть этой связи с клиентом, поэтому логика IMAP/SMTP должна жить
   там же, где физически решается задача устойчивости — на Edge Gateway
   (РФ-сторона), а не на app-стороне (SVC-INT), как было в текущей частичной
   реализации. Это отменяет риск §4.1 из v1.0 и переопределяет Этапы E2/E3.
2. **Роль бизнес-клиента — `administrator` в SaaS Administration.** Страница
   `:8081/channels` ([`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx))
   — единственная точка входа для добавления каналов; текущий guard
   `@Roles("administrator")` на `POST /v1/channels`
   ([`channels.controller.ts:28-31,45-60`](../../services/backend/src/modules/integration-gateway/channels.controller.ts))
   уже соответствует этому решению и **менять роль не требуется**. Это
   отменяет риск §4.3 из v1.0.

Терминология наследуется от [`mock-to-production.md`](./mock-to-production.md)
(`MP-06` — реальные каналы, `MP-12`/`MP-22` — Edge/RF-контур, `MP-20` —
секрет-менеджер) и от [`telegram-channel-production.md`](./telegram-channel-production.md)
(формат разбора, нумерация `G-N`). В отличие от Telegram, где входящее
принимается **на app-стороне** (SVC-INT `getUpdates`) и лишь маршрутизируется
через Edge опционально (`route_via_edge`), для Email оба направления —
**обязательно** через Edge, так как это прямое следствие решения 1 выше.

## Статус реализации (E0–E6)

> **Актуализация 2026-07-13 (проверка моков/разрывов по факту кода и стенда,
> HEAD `277ba0f`).** Практическая часть MP-12 для email **закрыта** отдельной
> веткой работ — self-hosted почтовый сервис «Bridge Mail»
> ([`mail-service-selfhosted.md`](./mail-service-selfhosted.md), M1–M5): боевые
> IMAP (`imapflow`, `edge-imap-mailbox.ts`) и SMTP (`nodemailer`,
> `edge-smtp-transport.ts`) реально работают против живого `mailserver` в
> RF-сети; входящий/исходящий драйверы подключены в рантайм
> (`edge-channel-drivers.ts`, гейт `EDGE_CHANNEL_DRIVERS=on`, на стенде **on**);
> backend-egress переведён на `egress_dispatch` (HTTP на `EDGE_CONTROL_URL`,
> коммит `e65de03`). Сквозной путь подтверждён на стенде — 3 inbound + 3 outbound
> email в `messages`.
>
> **Остался один реальный рантайм-разрыв: publisher `channel_credentials_sync`
> на стороне backend отсутствует.** Ничто в проде не шлёт креды каналов на Edge —
> `edge-control-plane.storeCredentials` наполняется только вручную скриптом
> `verify-full-path.ts`, играющим роль App-стороны. Поэтому в штатной работе Edge
> видит `channels: 0` (проверено в логах edge-gateway на стенде): входящий IMAP
> ничего не поллит (**менеджер не получает входящих**), а `egress_dispatch`
> падает с «No SMTP credentials». План закрытия —
> [`email-inbound-edge-implementation.md`](./email-inbound-edge-implementation.md).
>
> **Актуализация 2026-07-13 (живая проверка ИСХОДЯЩЕГО на стенде, HEAD `b5d44fe`).**
> Разрыв выше **закрыт**: publisher `channel_credentials_sync` реализован в
> [`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)
> (Ш1 — push при connect/update; Ш2 — bulk-resync каждые 60с по `EDGE_CONTROL_URL`).
> На стенде backend штатно логирует `Email creds resync: 1/1 каналов отправлено на
> Edge` каждые 60с. **Штатный исходящий путь подтверждён сквозняком без
> `verify-full-path.ts`:** выпущена admin-сессия → `POST /api/v1/messages`
> `{content:{text,subject}}` в email-диалог org `…0101` → `handoffEgress` →
> `egress_dispatch` на Edge → `EdgeEmailSender` (nodemailer SMTP) → `mailserver` →
> письмо **реально доставлено** в ящик `client@lissac-games.online` (проверено
> `doveadm`: `To`=реальный адрес клиента, `From: Support <support@…>`,
> `Subject`=`content.subject`, тело совпало). `messages.status=sent`, ack Edge
> `status=sent`.
> **Единственная оговорка — cold-start (§4.6):** ПЕРВОЕ письмо после рестарта Edge
> доставляется клиенту, но помечается `failed` (холодный nodemailer-транспорт
> превышает таймаут обёртки `deliverWithAdapterFailure`); ВТОРОЕ (тёплый транспорт)
> — `sent`. Воспроизведено на стенде (msg #1 `failed`+доставлено, msg #2 `sent`).
> **Лёгкий фикс §4.6 реализован и подтверждён живьём** (прогрев
> `transporter.verify()` при `channel_credentials_sync` + независимый
> `AbortController`-таймаут `fetch`, `EDGE_CONTROL_TIMEOUT_MS`). После ре-деплоя
> backend+edge (рестарт Edge → холодный транспорт) и первого creds-resync
> **первое** письмо менеджера ушло `status=sent` и доставлено в ящик `client@`
> (ранее это же первое-после-рестарта письмо было ложным `failed`). Детали — §4.6.

| Этап | Что закрыто | Статус (факт на 2026-07-13) |
|------|-------------|--------|
| **E0** | G-2/G-4 — структурные email-креды, `PUT /channels/:id` | ✅ backend |
| **E1** | G-1 — UI ввода IMAP/SMTP кред + заказ «Bridge Mail» + реальный `:test` через Edge | ✅ форма + автопровижн (M5) + `channel_test` (реальный IMAP LOGIN + SMTP verify) |
| **E2** | G-10 — control-plane App→Edge | ✅ приёмник (`/internal/edge/control/messages`), egress-паблишер и **publisher `channel_credentials_sync` (Ш1 push + Ш2 resync 60с)** — на стенде лог `Email creds resync: 1/1`. **MP-12:** control-plane переведён на VPN-туннель (relay edge-vpn-app + control-listener Edge, за гейтами), HTTP оставлен fallback'ом; in-process тесты зелёные, **боевой сокет проверен на стенде 2026-07-13** (creds-sync/egress/backend-e2e по реальному AmneziaWG-туннелю) |
| **E3** | G-5/G-9 — входящий IMAP-драйвер на Edge (RF-first) | ✅ боевой (`imapflow`), подключён — но инертен без creds-sync |
| **E4** | G-6/G-7 — SMTP-sender на Edge + поля эгресса | ✅ боевой (`nodemailer`) + egress по HTTP — инертен без creds-sync |
| **E5** | G-8 — email в manager-workspace (тип, тема) | ✅ frontend |
| **E6** | F1/F2 — вывод SVC-INT email-пути + сквозная приёмка | 🟢 **исходящее — штатный путь подтверждён живьём на стенде без verify-скрипта** (POST /messages → SMTP → ящик клиента, `status=sent`); оговорка cold-start §4.6. Входящее штатно — отдельно |

**Оставшиеся блоки (актуально):**
1. **Publisher `channel_credentials_sync` на backend — главный разрыв.** При
   `connectChannel`/`updateChannel` email-канала backend должен слать
   `channel_credentials_sync` на `EDGE_CONTROL_URL` (тем же путём, что уже
   работает для `egress_dispatch`), плюс периодический/bulk resync (кэш Edge —
   in-memory, теряется при рестарте → снова `channels: 0`). Без него весь
   email-путь инертен вне verify-скрипта.
2. **Боевая deliverability (M3):** порт 25 заблокирован, PTR/DNS не опубликованы —
   внешняя доставка отложена; внутри RF-сети `mailserver`↔Edge работает.
3. **Реальный сокет VPN-туннеля (MP-12):** App→Edge control-plane **переведён на
   туннель** (аддитивно, за гейтами) — `backend → (host-HTTP) → edge-vpn-app
   control-relay → (VPN-туннель) → Edge control-listener`, симметрично входящему.
   Прямой HTTP (`EDGE_CONTROL_URL`) сохранён как fallback для одно-хостового
   стенда; туннельный путь включает `EDGE_CONTROL_TUNNEL_URL` (backend),
   `EDGE_VPN_EDGE_CONTROL_URL` (edge-vpn-app) и `EDGE_VPN_CONTROL_LISTEN=on`
   (Edge). Без потерь при разрыве (офлайн-очередь + дедуп по `control_id`),
   покрыто in-process тестами. **Проверено на стенде (2026-07-13, реальный
   AmneziaWG-туннель):** creds-sync → `stored` + идемпотентность по `control_id`;
   egress_dispatch → реальная SMTP-попытка на Edge туннельными кредами (ответ
   mailserver вернулся по туннелю); backend end-to-end `Email creds resync: 1/1`
   через relay по туннелю, Edge поднял IMAP-драйвер. Побочно найдено и
   исправлено: control-RPC нужен отдельный таймаут `EDGE_VPN_CONTROL_TIMEOUT_MS`
   (30с) — egress/channel_test делают реальный SMTP/IMAP и превышают 5с data-plane.
4. ~~**Вложения → `storage_ref`** — по-прежнему непрозрачны (S3 отложен, §4.3).~~
   **Закрыто (2026-07-13):** реальное хранение байтов вложений на Edge (файловый
   том на RF, дедуп по content-hash) + рабочий `storage_ref`, резолвящийся
   backend-прокси к Edge при скачивании менеджером. Детали — §4.3 и раздел
   [«Хранение вложений»](#хранение-вложений-реализовано) ниже.

> **Ограничение документа.** Только план. Кода и диффов нет. Оценки
> трудозатрат в человеко-днях/датах — не приводятся; шаги — логические/
> зависимостные единицы. Все выводы получены чтением кода на ветке
> `issue-1-17113a10fe0c` (не runtime-прогоном); ссылки — `путь:строка`.

---

## 0. Текущее состояние (базовая линия)

Что **уже реально** и переиспользуется, не переписывается:

- Нормализация входящего письма и сборка исходящего payload (формат, не
  транспорт) —
  [`email-adapter.ts`](../../services/integration-platform/src/adapters/email/email-adapter.ts)
  (`normalizeIncomingPayload`, `createExternalPayload`), поверх общего
  M2-контракта
  [`m2-channel-adapter.ts`](../../services/integration-platform/src/adapters/common/m2-channel-adapter.ts).
  **Логика форматирования переиспользуется, но переносится физически на
  Edge Gateway** (см. решение 1) — сегодня она лежит в SVC-INT, что после
  этого плана становится их целевым расположением на Edge.
- Приём и запись входящего на стороне ядра — канально-агностичен —
  [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)
  (`acceptIngress`/`resolveEndpoint`/`resolveConversation`): Postgres, RLS
  `withTenant`, идемпотентность, `clients`/`communication_endpoints`/
  `conversations`/`messages`.
- Схема БД под каналы и per-tenant секрет —
  [`m2_schema.sql`](../../db/migrations/20260703124000000_m2_schema.sql)
  (`channels`, `channel_type` без enum-ограничения — `email` уже допустим),
  [`stage1_foundation.sql`](../../db/migrations/20260705233000000_stage1_foundation.sql)
  (`channels.credentials_envelope`, AES-256-GCM).
- Envelope-шифрование секрета канала (генерик, под один секрет-строку;
  расширяется под структурный объект на Этапе E0) —
  [`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts).
- Отправка сообщения менеджером — канально-агностична и уже маршрутизирует в
  `email`-эндпоинт без спецкода —
  [`communication-core-proxy.service.ts:162-288`](../../services/backend/src/modules/communication-core/communication-core-proxy.service.ts)
  (`createMessage`, `resolveConversationReplyEndpoint`, `handoffEgress`).
- Realtime-раздача входящего менеджеру (C7 → Redis Stream → Edge C7-мост → WS
  manager-workspace) — канально-агностична, событие несёт `channel` как есть —
  [`c7-realtime-event.publisher.ts`](../../services/backend/src/modules/communication-core/c7-realtime-event.publisher.ts),
  [`c7-redis-stream-bridge.ts`](../../services/edge-gateway/src/c7-redis-stream-bridge.ts).
- RF-first приземление и VPN-туннель Edge↔App (протокольный уровень: mTLS,
  AES-256-GCM, HKDF, backoff, backpressure) —
  [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts),
  [`vpn-tunnel.ts`](../../services/edge-gateway/src/vpn-tunnel.ts),
  RF-буфер — [`edge-message-buffer.ts`](../../services/edge-gateway/src/edge-message-buffer.ts).
  **Важное ограничение (см. G-10):** протокол и контракт `C9.EdgeTunnelMessage`
  ([`c9.ts`](../../packages/contracts/src/c9.ts)) сегодня моделируют только
  направление **Edge → App** (входящее сообщение + `EdgeTunnelAck` как
  квитанция на него). Направления **App → Edge** (синхронизация кред,
  диспетчеризация исходящей почты) в контракте и коде нет.
- Email как капабилити-профиль зарегистрирован в C6 Integration Gateway
  (`integration-gateway.facade.ts` — capability `email-adapter`) и допустим в
  DTO создания канала (`integration-gateway.dto.ts`).

Что **разорвано/замокано** и адресуется этим планом (`G-1…G-10`):

| ID | Разрыв | Где | Требование |
|----|--------|-----|------------|
| **G-1** | UI принимает только `credentials_ref` + `from_email`, нет полей IMAP/SMTP host/port/login/password/TLS | [`ChannelsPage.tsx:104-116`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx) | 1 |
| **G-2** | Модель секрета — одна опаковая строка на канал; не вмещает структурный набор IMAP+SMTP кред | [`stage1_foundation.sql`](../../db/migrations/20260705233000000_stage1_foundation.sql), [`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts) | 1 |
| **G-3** | `GET /internal/channels/secret` возвращает жёстко `{ token: string }` для любого `channel_type`, включая `email` | [`internal-channels.controller.ts:59-78`](../../services/backend/src/modules/integration-gateway/internal-channels.controller.ts) | 1, 2 |
| **G-4** | Нет `PUT/PATCH /channels/:id` — креды нельзя обновить/ротировать после создания | [`channels.controller.ts`](../../services/backend/src/modules/integration-gateway/channels.controller.ts) | 1 |
| **G-5** | Нет входящего IMAP-драйвера вообще (ни poll, ни IDLE) нигде в репозитории | integration-platform `src/inbound/*` (есть только Telegram); на Edge Gateway такого кода тоже нет | 4 |
| **G-6** | Существующий (частичный) email-egress — generic HTTP POST на **один глобальный** `EMAIL_DELIVERY_URL`/`EMAIL_DELIVERY_TOKEN`, живёт на SVC-INT (app-стороне), не per-org и не SMTP | [`real-channel-clients.ts:129-160`](../../services/integration-platform/src/delivery/real-channel-clients.ts), [`main.ts:42,63-66,88`](../../services/integration-platform/src/main.ts) | 5 |
| **G-7** | Egress-контракт `C2EgressDelivery` не несёт `recipient_ref`/`subject`/`from`/`In-Reply-To`/`References`; `to` фактически равен UUID диалога, а не адресу клиента; тема захардкожена `"Ответ"` | [`internal-messaging.dto.ts:546-594`](../../services/backend/src/modules/communication-core/internal-messaging.dto.ts), [`m2-channel-adapter.ts:268`](../../services/integration-platform/src/adapters/common/m2-channel-adapter.ts), [`email-adapter.ts:111-124`](../../services/integration-platform/src/adapters/email/email-adapter.ts) | 3, 5 |
| **G-8** | manager-workspace не моделирует `email` в типе `Channel`/allow-list — конверсии/сообщения email молча приводятся к `web_chat` | [`types.ts:37`](../../apps/manager-workspace/src/api/client/types.ts), [`http.ts:37,180,193,238`](../../apps/manager-workspace/src/api/client/http.ts) | 6 |
| **G-9** | На Edge Gateway нет ни строки email-кода (IMAP/SMTP/парсинг MIME) — вся (частичная) email-логика сегодня на app-стороне (SVC-INT), что прямо противоречит принятому решению 1 | `services/edge-gateway/src/*` (email-файлов нет) | 3, 4, 5 |
| **G-10** | **(новое, ключевое следствие решения 1).** VPN-туннель Edge↔App и контракт `C9.EdgeTunnelMessage`/`EdgeTunnelAck` — **однонаправленные** (только Edge→App, входящее сообщение + квитанция). Нет канала App→Edge для (а) синхронизации email-кред на Edge и (б) диспетчеризации исходящей почты (менеджер ответил → нужно сообщить Edge «отправь это письмо по SMTP»). Без этого разместить IMAP/SMTP на Edge технически невозможно | [`c9.ts`](../../packages/contracts/src/c9.ts) (нет App→Edge сообщения), [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts) (`tunnel.send` — только исходящий вызов от Edge) | 2 |

---

## 1. Целевая архитектура сквозного сценария

```
СИНХРОНИЗАЦИЯ КРЕД (App → Edge, control-plane через туннель):

  Backend: channels.credentials_envelope (IMAP+SMTP, зашифровано)
        │  по изменению канала ИЛИ периодически (pull с Edge)
        ▼
  VPN-туннель Edge↔App: новый тип control-сообщения
  C9.EdgeControlMessage { type: "channel_credentials_sync", ... }
        │
        ▼
  Edge Gateway: локальный зашифрованный кэш email-кред по organization_id
        (расшифровка — тем же механизмом, что RF payload cipher,
         ключ — из секрета Edge, не из открытого канала)


ВХОДЯЩЕЕ (клиент → менеджер):

  Клиент отправляет письмо
        │
        ▼
  IMAP-мейлбокс организации (провайдер/self-hosted)
        │  IMAP IDLE/poll С Edge Gateway, креды — из локального кэша выше
        ▼
  Edge Gateway: email-inbound-driver (новый)
        │  normalizeIncomingEmailMessage → C1.IngressMessage
        ▼
  Edge RF-буфер (Postgres, RF-first) → VPN-туннель (существующий путь
  Edge→App, `C9.EdgeTunnelMessage`, БЕЗ ИЗМЕНЕНИЙ) → CORE_INGRESS_URL
        │
        ▼
  Backend: acceptIngress → resolveEndpoint/resolveConversation
        ▼
  C7 realtime → Redis Stream → Edge C7-мост → WS → manager-workspace
        (диалог с каналом "email")


ИСХОДЯЩЕЕ (менеджер → клиент):

  manager-workspace: POST /api/v1/messages { conversationId, content, subject? }
        │
        ▼
  Backend: createMessage → resolveConversationReplyEndpoint (email-endpoint)
        │  channel="email" → handoffEgress → buildC2EgressDelivery
        │  (+ recipient_ref, subject, from, in_reply_to/references)
        ▼
  VPN-туннель Edge↔App: новый тип control-сообщения (App → Edge)
  C9.EdgeControlMessage { type: "egress_dispatch", delivery: {...} }
        │
        ▼
  Edge Gateway: email-egress-dispatcher (новый) → SMTP-клиент
        │  креды — из локального кэша (см. синхронизацию выше)
        ▼
  SMTP-сервер организации → письмо клиенту (с In-Reply-To/References)
        │
        ▼
  Edge Gateway → (через туннель) статус доставки → Backend
  (обновление messages.status, идемпотентность по message_id)
```

Ключевое отличие от Telegram-плана: там входящее и исходящее замыкаются
преимущественно на app-стороне (SVC-INT ↔ Telegram Bot API напрямую), а Edge
участвует опционально (`route_via_edge` для РФ-организаций). Для Email —
**и IMAP, и SMTP обязательно на Edge**, поэтому туннель становится не только
каналом приёма, но и каналом управления (креды) и диспетчеризации (исходящая
почта). Это требует расширения протокола (Этап E2 / G-10) до начала работы
над самими IMAP/SMTP-драйверами.

---

## 2. Этапы и последовательность

Этапы **E0…E6**, зависимости внутри этапа не критичны, между этапами —
логический порядок (что должно быть готово раньше). Порядок изменён
относительно v1.0: сначала фундамент кред и туннельный control-plane (без
него IMAP/SMTP на Edge не запустить), затем сами драйверы.

### Этап E0 — Фундамент структурных секретов канала — ✅ ВЫПОЛНЕН

Закрывает G-2, частично G-1/G-3/G-4.

> **Статус: реализовано** (backend). Что сделано:
> - Модуль структурных email-кред
>   [`email-channel-credentials.ts`](../../services/backend/src/common/secrets/email-channel-credentials.ts):
>   тип `EmailChannelCredentials` (imap/smtp/from_email/from_name),
>   `serializeEmailChannelCredentials`/`parseEmailChannelCredentials` с
>   дискриминатором `kind`/`version`; пароли сохраняются без тримминга.
> - DTO `EmailChannelCredentialsDto`/`EmailEndpointCredentialsDto` +
>   `email_credentials` в `ConnectChannelRequestDto` + новый
>   `UpdateChannelRequestDto`
>   ([`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts)).
> - Фасад: `connectChannel` принимает структурные email-креды (сериализует и
>   шифрует существующим envelope-механизмом), новый `updateChannel` (ротация
>   секрета/правка name/config), общий `resolveSecretPlaintext` с guard
>   «email_credentials только для channel_type=email»
>   ([`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts)).
> - `PUT /v1/channels/:id` под `@Roles("administrator")`
>   ([`channels.controller.ts`](../../services/backend/src/modules/integration-gateway/channels.controller.ts)).
> - Тесты: unit
>   [`email-channel-credentials.spec.ts`](../../services/backend/test/unit/email-channel-credentials.spec.ts)
>   + расширенный интеграционный
>   [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts)
>   (структурный round-trip, write-only секрет, ротация email/telegram, 404,
>   mismatch 400). `tsc --noEmit` зелёный.
>
> Осталось в рамках G-3 на Этап E2: отдача структурного объекта наружу через
> `/internal/channels/secret` / синхронизацию на Edge (сейчас S2S-эндпоинт
> по-прежнему отдаёт `{ token }` — для email это JSON-строка кред, парсится
> `parseEmailChannelCredentials`).

- Расширить envelope-секрет с «одна строка» до **структурного JSON-объекта**
  внутри уже существующего шифрования (`ChannelSecretCipher.encrypt` уже
  шифрует произвольную строку — плейнтекстом кладём
  `JSON.stringify({ imap: {...}, smtp: {...}, from_email })` перед
  шифрованием; формат envelope `{alg,kid,iv,tag,ciphertext,created_at}` не
  меняется).
- Схема email-кред: `imap.host`, `imap.port`, `imap.tls`, `imap.username`,
  `imap.password`, `smtp.host`, `smtp.port`, `smtp.tls`, `smtp.username`,
  `smtp.password`, `from_email`, `from_name?`.
- Добавить `PUT /v1/channels/:id` (ротация/правка кред) — сейчас есть только
  `POST` (create); закрывает G-4. Guard — `@Roles("administrator")`, как у
  `POST` (решение 2 — без изменений роли).

**DoD:** email-креды сохраняются структурным объектом через API на Backend;
получить обратно **нельзя** (write-only пароль), обновить — можно.

### Этап E1 — UI ввода кред в SaaS Administration — ✅ ВЫПОЛНЕН (форма + реальный `:test` через Edge)

Закрывает G-1. Роль/страница — по решению 2, без изменений.

> **Статус: реализовано** (frontend). Что сделано:
> - Структурная форма email-коннектора на `:8081/channels`
>   ([`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx)):
>   `secretKind: "email"` с блоками **IMAP** и **SMTP** (host/port/TLS/логин/
>   пароль) + `from_email`/`from_name`, вместо прежнего единственного
>   `credentials_ref`. Отправляет `email_credentials` в `POST /v1/channels`
>   (DTO из E0); пароли — `type="password"`, форма сбрасывается после
>   сохранения → **не отображаются повторно** (write-only). Клиентская
>   валидация: обязательные host/логин/пароль, порт 1–65535, `from_email`.
> - API-тип `EmailChannelCredentials` + `email_credentials` в
>   `ConnectChannelRequest`
>   ([`types.ts`](../../apps/saas-admin/src/api/client/types.ts)); MSW-мок
>   генерирует `credentials_ref` под структурные креды
>   ([`handlers.ts`](../../apps/saas-admin/src/api/mocks/handlers.ts)).
> - Кнопка «Проверить подключение» вызывает `POST /channels/:id:test` (как
>   раньше).
> - Тесты (vitest)
>   [`m2-channels-knowledge.test.tsx`](../../apps/saas-admin/test/m2-channels-knowledge.test.tsx):
>   заполнение IMAP/SMTP → `createChannel` с `email_credentials` (без
>   `credentials_ref`); валидация обязательных полей блокирует отправку. `tsc`
>   зелёный, регрессий нет (saas-admin 100).
>
> **Реальная проверка `:test` через Edge — реализована.** Добавлен новый тип
> App→Edge control-сообщения `C9.EdgeControlMessage type=channel_test`
> ([`c9.ts`](../../packages/contracts/src/c9.ts) + схема, валидатор требует
> `channel_type`). Backend `testChannel` для email
> ([`integration-gateway.facade.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.facade.ts),
> `testEmailChannel`/`publishChannelTest`) резолвит структурные креды из
> `credentials_envelope` и шлёт `channel_test` на `EDGE_CONTROL_URL` (тем же
> HTTP-путём, что creds-sync/egress); Edge
> ([`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts) →
> [`edge-channel-tester.ts`](../../services/edge-gateway/src/edge-channel-tester.ts))
> выполняет **реальный IMAP LOGIN** (`imapflow` connect+logout) и **SMTP verify**
> (`nodemailer transporter.verify()`, EHLO+AUTH) боевыми клиентами с РФ-стороны и
> возвращает `connected`/`error`+причину синхронным ack. Креды едут в payload
> (проверка работает даже до creds-sync); `channel_test` НЕ дедуплицируется по
> `control_id` (проба всегда свежая). Без `EDGE_CONTROL_URL` backend честно отдаёт
> `error` с причиной, а не ложный `connected` (проверять негде — по решению 1
> IMAP/SMTP только на Edge). Невалидные креды (обычный пароль вместо app-password,
> закрытый порт, неверный хост) теперь дают `error`, а не обобщённый `connected`.
> Тесты: контракт `channel_test`
> ([`c9-control-message.test.ts`](../../packages/contracts/test/unit/c9-control-message.test.ts)),
> тестер ([`edge-channel-tester.test.ts`](../../services/edge-gateway/test/unit/edge-channel-tester.test.ts)),
> control-plane роутинг/дедуп/креды из payload-или-кэша
> ([`edge-control-plane.test.ts`](../../services/edge-gateway/test/unit/edge-control-plane.test.ts)),
> backend `:test` (connected/error/нет кред/нет URL/Edge недоступен) в
> [`integration-gateway.facade.spec.ts`](../../services/backend/test/unit/integration-gateway.facade.spec.ts)
> + сквозной через HTTP в
> [`channels.spec.ts`](../../services/backend/test/integration/channels.spec.ts).
> `tsc` зелёный; регрессий нет (edge 180, contracts 42, backend facade unit 20 +
> channels integration 14).
>
> Осталось (боевой daemon Edge, MP-12): реальные сетевые IMAP/SMTP-сокеты вместо
> инъектируемых в тестах фабрик (`channelTester` в
> [`edge-channel-drivers.ts`](../../services/edge-gateway/src/edge-channel-drivers.ts)
> уже собран боевыми клиентами — проверяется на стенде). Опционально —
> UI-редактирование/ротация кред через `PUT /v1/channels/:id` (endpoint готов в E0).

- Форма на `:8081/channels` (`ChannelsPage.tsx`) для коннектора `email`: два
  блока (IMAP, SMTP) с host/port/TLS/username/password, плюс
  `from_email`/`from_name`.
- Кнопка **«Проверить соединение»** — `POST /channels/:id:test`; для email
  реализовать содержательную проверку (реальный `IMAP LOGIN` и
  `SMTP EHLO+AUTH`). Технически эта проверка **тоже должна идти через Edge**
  (см. Этап E2) — иначе она проверяет доступность IMAP/SMTP-сервера с
  app-стороны, а не с той, что реально будет использоваться для приёма/
  отправки.
- Пароли не отображаются повторно после сохранения (только «изменить»).

**DoD:** administrator вводит IMAP+SMTP креды организации на `:8081/channels`,
видит результат реальной проверки подключения **с Edge-стороны**, может их
сменить.

### Этап E2 — Control-plane туннеля: синхронизация кред и диспетчеризация egress (App → Edge) — ✅ ВЫПОЛНЕН (control-plane; боевой daemon — с MP-12)

Закрывает **G-10** — фундаментальная зависимость для E3/E4. Новый этап
относительно v1.0, прямое следствие решения 1.

> **Статус: реализовано на уровне зрелости data-plane** (детерминированный
> in-process туннель, полностью покрыт тестами — как существующий
> `vpn-tunnel.ts`/`edge-cluster.ts`, боевой TCP/TLS-сокет — веха MP-12). Что
> сделано:
> - Контракт `C9.EdgeControlMessage` + `C9.EdgeControlAck` (типы
>   `channel_credentials_sync`/`egress_dispatch`; тип `channel_test` добавлен на
>   Этапе E1) в
>   [`c9.ts`](../../packages/contracts/src/c9.ts) + JSON-схемы
>   [`c9-edge-control-message.schema.json`](../../packages/contracts/json-schema/c9-edge-control-message.schema.json),
>   [`c9-edge-control-ack.schema.json`](../../packages/contracts/json-schema/c9-edge-control-ack.schema.json);
>   валидаторы с проверкой payload по типу.
> - Edge-обработчик
>   [`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts):
>   `channel_credentials_sync` → креды в **зашифрованном in-memory кэше**
>   (RF-payload-cipher, не персистятся в открытом виде), `getEmailCredentials`
>   для E3/E4; `egress_dispatch` → инъектируемый `emailSender` (реальный SMTP —
>   E4) + статус `sent`/`failed`; идемпотентность по `control_id`.
> - App-клиент
>   [`edge-control-client.ts`](../../services/edge-gateway/src/edge-control-client.ts):
>   **офлайн-очередь** — при разрыве туннеля сообщения буферизуются и
>   дренажируются при восстановлении (симметрично RF-буферу), без потерь и без
>   двойной отправки (дедуп Edge по `control_id`).
> - Транспорт поверх сессии
>   [`edge-control-tunnel.ts`](../../services/edge-gateway/src/edge-control-tunnel.ts):
>   App→Edge кадры запечатываются тем же сеансовым ключом/форматом, что и
>   data-plane (`sealTunnelFrame`/`openTunnelFrame`, AES-256-GCM), разрыв —
>   `link.cut()/restore()`.
> - Тесты (node:test): контракт
>   [`c9-control-message.test.ts`](../../packages/contracts/test/unit/c9-control-message.test.ts),
>   [`edge-control-plane.test.ts`](../../services/edge-gateway/test/unit/edge-control-plane.test.ts),
>   [`edge-control-client.test.ts`](../../services/edge-gateway/test/unit/edge-control-client.test.ts)
>   (доставка, разрыв→очередь→дренаж, идемпотентность, порядок). `tsc` зелёный,
>   регрессий нет (edge 79, contracts 40, root C9-contract 3).
>
> Осталось (ложится вместе с боевым daemon туннеля, MP-12, и Этапом E4):
> - Реальная привязка App-клиента к живой VPN-сессии вместо in-process
>   транспорта; проброс RF-секретов/`DATABASE_URL` в edge-gateway (MP-22).
> - Backend-сторона: публикация `channel_credentials_sync` при create/update
>   email-канала (Этап E0) и перевод `handoffEgress`
>   ([`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts))
>   для `channel="email"` с HTTP-эгресса SVC-INT на `egress_dispatch` через
>   туннель. Сознательно НЕ трогается сейчас: без запущенного daemon это
>   сломало бы текущий (mock/HTTP) путь и создало бы ложное впечатление
>   готового канала.

- Расширить контракт C9 (`packages/contracts/src/c9.ts`) новым типом
  сообщения для направления **App → Edge**, например
  `C9.EdgeControlMessage` с полями `type` (`channel_credentials_sync` |
  `egress_dispatch`), `organization_id`, `payload`, плюс схема
  `c9-edge-control-message.schema.json` по аналогии с существующими
  `c9-edge-tunnel-message.schema.json`/`c9-edge-tunnel-ack.schema.json`.
- В `vpn-tunnel.ts`/`edge-cluster.ts` добавить приём control-сообщений на
  Edge-стороне (сейчас `tunnel.send` — только исходящий вызов **от** Edge;
  нужен встречный `tunnel.receive`/подписка на App→Edge поток той же
  mTLS+AES-256-GCM сессией).
- **Синхронизация кред:** Backend публикует `channel_credentials_sync` при
  создании/обновлении email-канала (Этап E0) и/или по периодическому pull
  с Edge (TTL кэша). Edge хранит расшифрованные креды **только в памяти/
  локальном зашифрованном кэше**, не персистит в открытом виде.
- **Диспетчеризация исходящей почты:** `handoffEgress` на Backend
  (`internal-messaging.service.ts`) для `channel="email"` вместо HTTP-вызова
  на SVC-INT отправляет `egress_dispatch` через туннель на Edge; Edge
  подтверждает приём (аналог `EdgeTunnelAck`) и после фактической отправки
  сообщает статус (`sent`/`failed`) обратно тем же путём.
- Backpressure/офлайн: если туннель разорван, `egress_dispatch` встаёт в
  очередь на Backend (переиспользуется существующий retry-queue
  `delivery-engine.ts`/resilience-обвязка) и передаётся при восстановлении
  связи — симметрично тому, как Edge буферизует входящее в RF-буфере при
  разрыве.

**DoD:** Backend может (а) протолкнуть структурные email-креды на Edge и
(б) продиспетчеризовать исходящее письмо на Edge через туннель; Edge
подтверждает получение и статус отправки; при разрыве туннеля ничего не
теряется (переживает переподключение с той же гарантией, что и входящее
RF-first).

### Этап E3 — Входящий IMAP-драйвер на Edge Gateway — ✅ ВЫПОЛНЕН (драйвер; боевой IMAP-клиент — с daemon)

Закрывает G-5, G-9 (входящее направление).

> **Статус: реализовано на уровне зрелости data-plane** (детерминированный,
> транспорт-агностичный драйвер, полностью покрыт тестами; реальный сетевой
> IMAP-клиент/IDLE — как реальный сокет туннеля, отдельная веха MP-12). Что
> сделано:
> - Детерминированные id
>   [`edge-ids.ts`](../../services/edge-gateway/src/edge-ids.ts) (`uuidFromText`
>   совместим с ядром/SVC-INT; стабильные `message_id` из `Message-ID` и
>   `endpoint_id` из адреса).
> - Нормализатор письма → конверт C2.IngressMessage
>   [`edge-email-ingress.ts`](../../services/edge-gateway/src/edge-email-ingress.ts):
>   порт inbound-логики SVC-INT email-адаптера на Edge (текст/тема/вложения →
>   `storage_ref`, `identity: verified_email`, `conversation_ref` из `thread_id`)
>   + поля верхнего уровня `id`/`endpoint_id`/`idempotency_key` для RF-буфера.
> - Драйвер
>   [`edge-email-inbound-driver.ts`](../../services/edge-gateway/src/edge-email-inbound-driver.ts):
>   реестр email-каналов, резолв кред из control-plane кэша (Этап E2), выборка
>   через инъектируемый `createMailbox` (IMAP IDLE/poll — забота реализации),
>   **RF-first приём через `EdgeCluster.ingest`** (RF-буфер → туннель →
>   `CORE_INGRESS_URL`), дедуп по `Message-ID`, курсор UID, повтор без потери при
>   сбое приёма.
> - Тесты (node:test):
>   [`edge-email-ingress.test.ts`](../../services/edge-gateway/test/unit/edge-email-ingress.test.ts),
>   [`edge-email-inbound-driver.test.ts`](../../services/edge-gateway/test/unit/edge-email-inbound-driver.test.ts)
>   — включая end-to-end через **реальный `edge-cluster` + ломаемый туннель**:
>   RF-first буферизация при разрыве и пересылка после восстановления (без
>   потерь), дедуп, пропуск канала без кред, повтор при сбое. `tsc` зелёный,
>   регрессий нет (edge 91).
>
> Осталось (ложится вместе с боевым daemon Edge, MP-12/MP-22):
> - Реальный IMAP-клиент (`createMailbox` поверх боевой IMAP-библиотеки, IDLE или
>   poll) вместо инъектируемого в тестах.
> - Wiring драйвера в `edge-gateway` runtime: `listChannels` из backend,
>   `resolveCredentials` из живого control-plane кэша, `ingest` из поднятого
>   `EdgeCluster` (сейчас — тестовая обвязка, как у самого `edge-cluster.ts`).

- Реализовать email-inbound-driver **в `services/edge-gateway/src`** (не в
  SVC-INT): список активных email-каналов и креды — из локального кэша
  (Этап E2), подключение по IMAP (IDLE предпочтительно, иначе poll с
  интервалом), парсинг MIME (текст/HTML/вложения → `storage_ref`),
  дедупликация по `Message-ID`.
- Переиспользовать существующий нормализатор
  `normalizeIncomingEmailMessage` (`email-adapter.ts:45-85`) — логика
  форматирования переносится/импортируется на Edge без изменений по сути.
- Публикация в ingress — **всегда** через существующий Edge-путь: RF-буфер →
  `C9.EdgeTunnelMessage` → `CORE_INGRESS_URL` (не опционально, в отличие от
  Telegram: email по решению 1 не имеет прямого app-side пути).

**DoD:** письмо клиента реально забирается Edge Gateway по IMAP,
нормализуется, RF-first приземляется в буфере и попадает в диалог менеджера
через существующий туннельный путь.

### Этап E4 — Исходящая доставка (SMTP) на Edge Gateway — ✅ ВЫПОЛНЕН (sender + контракт; боевой SMTP-клиент — с daemon)

Закрывает G-6, G-9 (исходящее направление), частично G-7.

> **Статус: реализовано на уровне зрелости data-plane** (транспорт-агностичный
> SMTP-sender, покрыт тестами; реальный сетевой nodemailer-транспорт — как
> реальный IMAP-клиент E3 и сокет туннеля, веха MP-12). Что сделано:
> - Edge SMTP-sender
>   [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts):
>   реализует `EdgeEmailSender` (сеам `egress_dispatch` из E2), собирает MIME —
>   **`To` = реальный адрес клиента** (`recipient_ref`, не UUID диалога),
>   `From` = адрес организации из кред (или явный override), `Subject`,
>   `In-Reply-To`/`References`, детерминированный `Message-ID` из `message_id`
>   (идемпотентность), вложения по `storage_ref`; кэш транспортов per-SMTP-конфиг;
>   SMTP-транспорт инъектируется (`createTransport`).
> - Backend-контракт эгресса (G-7): в `C2EgressDelivery`/`buildC2EgressDelivery`
>   ([`internal-messaging.dto.ts`](../../services/backend/src/modules/communication-core/internal-messaging.dto.ts))
>   добавлены `recipient_ref` (= `endpoint.external_id` — чинит адресацию на UUID),
>   `subject`/`from`/`in_reply_to`/`references` (из `content`, заполняются
>   продюсером — manager UI E5). Аддитивно, для всех каналов.
> - Тесты (node:test)
>   [`edge-email-sender.test.ts`](../../services/edge-gateway/test/unit/edge-email-sender.test.ts):
>   корректный To/From/Subject/threading/Message-ID, дефолт From из кред, кэш
>   транспорта, ошибки без адреса/кред, **end-to-end через control-plane E2**
>   (`egress_dispatch` → sender → ack `sent` + `external_message_id`;
>   идемпотентность по `control_id`). `tsc` зелёный, регрессий нет (edge 98,
>   backend unit 151).
>
> Осталось (ложится вместе с боевым daemon Edge, MP-12, и Этапом E6):
> - Реальный nodemailer SMTP-транспорт (`createTransport`) вместо инъектируемого.
> - Backend: перевод `handoffEgress` для `channel="email"` на `egress_dispatch`
>   через туннель (E2-остаток) + populate `in_reply_to`/`references` из
>   сохранённого `Message-ID` входящего письма (sender их уже поддерживает);
>   вывод из эксплуатации app-side `EMAIL_DELIVERY_URL` (Этап E6).

- Реализовать **реальный SMTP-клиент** на Edge Gateway (например, на базе
  nodemailer), запускаемый по `egress_dispatch` из Этапа E2. Существующий
  generic HTTP-клиент `createEmailHttpGatewayClient`
  (`real-channel-clients.ts:103-114`) и его wiring в `main.ts` SVC-INT
  **выводятся из эксплуатации для email** (заменяются, не расширяются) —
  решение 1 явно относит SMTP на Edge, а не на app-side HTTP-шлюз.
- Расширить `C2EgressDelivery`/`buildC2EgressDelivery`
  (`internal-messaging.dto.ts:546-594`) полями `recipient_ref` (из
  `endpoint.external_id`), `subject`, `from`, `in_reply_to`, `references` —
  эти поля едут в `egress_dispatch` через туннель на Edge.
- На Edge: собрать письмо (`to`/`subject`/`from`/threading-заголовки) из
  переданных полей, переиспользуя формат `createExternalPayload`
  (`email-adapter.ts:111-124`) как основу.
- UI-поле темы в manager-workspace (Этап E5) прокидывается в
  `POST /api/v1/messages` → далее по цепочке.

**DoD:** менеджер отвечает клиенту, письмо реально уходит по SMTP **с Edge
Gateway** с правильным `To` (адрес клиента, не UUID), корректной темой и
`From` организации; повтор отправки не дублирует письмо (идемпотентность по
`message_id`, сквозная через туннель).

### Этап E5 — Email в manager-workspace — ✅ ВЫПОЛНЕН

Закрывает G-8.

> **Статус: реализовано** (frontend, без изменений backend). Что сделано:
> - `email` добавлен в union `Channel` и в runtime-allow-list `CHANNELS`
>   ([`types.ts`](../../apps/manager-workspace/src/api/client/types.ts),
>   [`http.ts`](../../apps/manager-workspace/src/api/client/http.ts)) — email-
>   диалоги/сообщения больше НЕ приводятся молча к `web_chat`
>   (`normalizeConversation`/`normalizeMessage`/`normalizeEndpoint`).
> - Тема письма: поле «Тема письма» в `DialogPage.tsx` для email-диалогов,
>   уходит в `POST /api/v1/messages` **внутри `content`** как объект
>   `{text, subject}` — ядро уже принимает content объектом, а egress читает
>   `content.subject` (Этап E4), поэтому backend/DTO менять не потребовалось
>   (не-email отправки остаются `content: string`). Тема сбрасывается при смене
>   диалога и после успешной отправки.
> - Шапка диалога показывает канал (`CHANNEL_LABELS`, вариант `email`) и адрес
>   получателя (email-endpoint клиента) для email-диалогов.
> - Тесты (vitest)
>   [`http-client-tenant.test.ts`](../../apps/manager-workspace/test/http-client-tenant.test.ts):
>   email не приводится к `web_chat`; тема вкладывается в `content`; без темы
>   content остаётся строкой. `tsc --noEmit` зелёный, регрессий нет (mws 34).
>
> Осталось (после боевого backend→Edge handoff, Этап E6): фактическая доставка
> темы до SMTP зависит от перевода `handoffEgress` на `egress_dispatch` (E2/E6);
> на уровне контракта тема уже доезжает (`content.subject` → `message.subject`).

- Добавить `"email"` в union `Channel` и в runtime-список `CHANNELS`
  (`types.ts:37`, `http.ts:37`), убрать молчаливый coerce в `web_chat`
  (`normalizeConversation`/`normalizeMessage`/эндпоинты, `http.ts:180,193,238`).
- В `DialogPage.tsx`: поле темы письма при ответе в email-диалоге (передаётся
  в `POST /api/v1/messages` вместе с `content`), отображение темы/адресата в
  шапке диалога.
- Лейбл канала (`channelLabel`, `DialogPage.tsx:127,284`) — добавить вариант
  для email.

**DoD:** email-диалог отображается в manager-workspace как `email` (не
`web_chat`), менеджер видит тему письма и может её задать при первом ответе.

### Этап E6 — Снятие моков, вывод старого пути и сквозная приёмка — ✅ ВЫПОЛНЕН (in-process контур; боевой daemon — MP-12)

Финальная проверка, закрывает остаточные разрывы v1.0 (F1/F2 из аудита).

> **Статус: реализовано в пределах детерминированного in-process контура**
> (реальные IMAP/SMTP-сокеты, межсерверный туннель и boot боевого daemon —
> веха MP-12, вне текущего контура). Что сделано:
> - **Вывод app-side email-пути из SVC-INT (F1):** `email` больше не собирается
>   в `createRealChannelClientsFromEnv` и не регистрируется в delivery-channel
>   `main.ts` — исходящая почта уходит по SMTP на Edge (E4), минуя
>   SVC-INT-диспетчер и `createMockExternalChannel()`. `EMAIL_DELIVERY_URL`/
>   `TOKEN` помечены deprecated в `.env.example`; `createEmailHttpGatewayClient`
>   сохранён как generic-клиент для сторонних email-over-HTTP провайдеров (§4.2).
>   ([`real-channel-clients.ts`](../../services/integration-platform/src/delivery/real-channel-clients.ts),
>   [`main.ts`](../../services/integration-platform/src/main.ts)).
> - **Сквозная приёмка (e2e):**
>   [`email-channel-e2e.test.ts`](../../services/edge-gateway/test/integration/email-channel-e2e.test.ts)
>   собирает модули E2–E5 и прогоняет полный сценарий DoD: синхронизация кред →
>   приём письма (IMAP → RF-first → туннель) → ответ менеджера (`egress_dispatch`
>   → SMTP) с **`In-Reply-To` = Message-ID входящего** (threading) → отсутствие
>   потерь при разрыве туннеля в обе стороны (RF-буфер на входящем,
>   офлайн-очередь на исходящем) → идемпотентность по `control_id`; отдельно —
>   приём заблокирован до синхронизации кред.
> - `tsc` зелёный; регрессий нет (edge 100, SVC-INT unit 73 + integration 27).
>
> Осталось (единственная внешняя веха — MP-12/MP-22, реальная межсерверная сеть):
> - Реальные сетевые клиенты вместо инъектируемых: IMAP (IDLE/poll) в E3,
>   nodemailer SMTP в E4, TCP/TLS-сокет туннеля (data + control) вместо
>   in-process link; boot Edge-daemon с проброшенными RF-секретами/`DATABASE_URL`.
> - Backend: перевод `handoffEgress` для `channel="email"` на `egress_dispatch`
>   через туннель + публикация `channel_credentials_sync` при create/update
>   email-канала + populate `in_reply_to`/`references` из сохранённого
>   `Message-ID` входящего; `health` перестаёт репортить `mode:"mock"` для email
>   после подключения реальных клиентов.
> - Полностью боевая приёмка (пп. 1–6 ниже) — на реальном окружении после MP-12.

- Удалить/выключить email-адаптер и `channelClients.email` из SVC-INT
  `main.ts` (Этапы E3/E4 переносят логику на Edge) либо явно
  задокументировать как выведенный из эксплуатации путь.
- В боевом профиле: `DELIVERY_ALLOW_MOCK_FALLBACK=false` для остальных
  каналов не затрагивается; email больше не проходит через
  `createMockExternalChannel()`, так как egress уходит через туннель на
  Edge, минуя SVC-INT-диспетчер.
- Сквозной сценарий (ручная или e2e-приёмка):
  1. administrator вводит IMAP/SMTP креды на `:8081/channels`, «Проверить
     соединение» проходит с Edge-стороны;
  2. клиент отправляет письмо на ящик организации;
  3. письмо реально забирается Edge по IMAP, RF-first приземляется, попадает
     в диалог менеджера (тема, вложения, канал `email`);
  4. менеджер отвечает — Backend диспетчеризует через туннель, Edge реально
     отправляет письмо по SMTP; клиент получает ответ в той же цепочке
     (`In-Reply-To` совпадает с `Message-ID` исходного письма);
  5. разрыв туннеля во время отправки/приёма не теряет сообщение
     (буферизация и на входящей, и на исходящей стороне);
  6. повторная попытка доставки не дублирует письмо (идемпотентность).

**DoD:** сценарий выше воспроизводится без моков и без обращения к
app-side HTTP-шлюзу для email; `health`/статус канала не сообщает
`mode:"mock"` для email; весь email-трафик (креды, входящее, исходящее)
физически проходит через VPN-туннель Edge↔App.

---

## 3. Сводка «разрыв → этап → критерий закрытия»

| ID | Разрыв | Этап | Закрыт когда |
|----|--------|------|--------------|
| G-1 | Нет UI для IMAP/SMTP кред | E1 | Форма на `:8081/channels` сохраняет структурные креды, «Проверить соединение» реально стучится в IMAP/SMTP с Edge-стороны |
| G-2 | Секрет — одна строка, не структура | E0 | Envelope хранит JSON с `imap`/`smtp`/`from_email` |
| G-3 | `/internal/channels/secret` возвращает только `{token}` | E0 | Резолвер/синхронизация отдаёт структурный объект для `channel_type=email` |
| G-4 | Нет обновления кред | E0 | `PUT /v1/channels/:id` реализован |
| G-5 | Нет IMAP-драйвера | E3 | Письма реально забираются и нормализуются на Edge |
| G-6 | Egress — глобальный HTTP-шлюз на app-стороне | E4 | Реальный SMTP-клиент на Edge, диспетчеризуемый через туннель |
| G-7 | Нет `recipient_ref`/`subject`/`from`/threading в egress | E4 | `To` = адрес клиента, тема реальная, `In-Reply-To` проставлен |
| G-8 | manager-workspace не знает про `email` | E5 | `Channel` включает `"email"`, нет coerce в `web_chat` |
| G-9 | IMAP/SMTP не на Edge | E3, E4 | Оба драйвера физически исполняются в `services/edge-gateway` |
| **G-10** | Туннель однонаправленный, нет App→Edge control-plane | **E2** | `C9.EdgeControlMessage` реализован, синхронизация кред и `egress_dispatch` работают через туннель |

---

## 4. Риски и решения к принятию

Риски §4.1 («где IMAP/SMTP») и §4.3 («кто бизнес-клиент») из v1.0 —
**закрыты решениями 1 и 2** в начале документа. Остаются:

1. **Протокол App→Edge control-plane (Этап E2) — новая поверхность
   туннеля.** Расширение `C9` — это изменение защищённого канала Edge↔App
   (mTLS, AES-256-GCM), требует того же уровня строгости, что и существующий
   `EdgeTunnelMessage`/`Ack` (валидация схемой, идемпотентность,
   backpressure). Риск — сложность Высокая, так как это фактически новый
   тип трафика через инфраструктуру, спроектированную изначально только под
   одно направление.
2. **Формат IMAP-приёма — IDLE или poll.** IDLE снижает задержку и нагрузку
   на провайдера, но не все провайдеры/тарифы поддерживают его стабильно;
   poll — проще, но с задержкой и риском рейт-лимитов. Решение влияет на
   Этап E3.
3. **Хранение вложений — РЕШЕНО и РЕАЛИЗОВАНО (2026-07-13).** `attachments[].storage_ref`
   в C1 — непрозрачная строка; байты писем физически сохраняются на **Edge/RF**
   (файловый том, MVP; MinIO/S3 — тем же интерфейсом позже, сознательно отложен,
   см. `mock-to-production.md` §4.15). Детали ниже, раздел
   [«Хранение вложений»](#хранение-вложений-реализовано).
4. **Судьба существующего `EMAIL_DELIVERY_URL`-пути в SVC-INT.** Решение 1
   подразумевает его вывод из эксплуатации для email (Этап E6). Нужно
   подтвердить, что альтернативных сценариев (например, сторонний
   HTTP-based email-провайдер вместо прямого SMTP) на MVP не требуется —
   если требуется, это отдельный канал/тип коннектора, не «email» в текущем
   смысле.
5. **Доступность Edge под нагрузкой control-plane.** Синхронизация кред и
   диспетчеризация egress добавляют новый постоянный трафик через туннель;
   нужно убедиться, что это не конкурирует за пропускную способность/
   backpressure-лимиты с основным RF-first входящим потоком (Этап E2,
   совместно с существующими метриками `edge-cluster.ts`).
6. **Робастность egress: ложный `failed` на cold-start SMTP (открыто).**
   Реализованное backend-плечо `handoffEgress → egress_dispatch`
   ([`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts),
   `forwardEgressToEdgeControl`; коммит `e65de03`) **синхронно** ждёт ack Edge,
   а Edge-intake отвечает только ПОСЛЕ фактической SMTP-отправки. Первое письмо
   после старта Edge — «холодное» (nodemailer создаёт транспорт и поднимает
   TCP+STARTTLS+AUTH), задержка превышает таймаут обёртки `deliverWithAdapterFailure`
   («M5 dependency timed out») → сообщение помечается `failed`, **хотя письмо
   реально уходит и клиент его получает** (подтверждено на стенде: тёплый
   транспорт — ~250 мс, `sent`). Причины: (а) связанность backend со всем внешним
   SMTP в одном вызове; (б) у `fetch` в `forwardEgressToEdgeControl` нет своего
   таймаута; (в) cold-start транспорта.
   - **Лёгкий фикс (быстро, без редизайна):** явный `AbortController`-таймаут у
     `fetch` (~15–20 с, независимый от M5-обёртки); прогрев транспорта на Edge
     (`transporter.verify()` при `channel_credentials_sync`); ретрай с
     идемпотентностью по `control_id` (повтор возвращает дедуплицированный `sent`).
   - **Правильная цель (async-ack, симметрия с входящим RF-first):** Edge
     подтверждает **приём** мгновенно (`queued`), SMTP-отправка — в фоне,
     терминальный статус приезжает обратным колбэком через существующий
     `recordDeliveryAttempt` (`POST /internal/delivery/attempts`). Требует
     разрешить переход `sent → failed` в машине статусов C1 **или** ввести
     промежуточный статус `dispatched`/`queued`. Снимает зависимость backend от
     скорости/доступности SMTP и даёт настоящий `delivered` vs `sent`.
   - **Статус (2026-07-13): лёгкий фикс реализован.** (а) Прогрев транспорта на
     Edge — `EdgeEmailSender.warmUp()` вызывает `transporter.verify()` при
     `channel_credentials_sync` (`edge-control-plane.storeCredentials` →
     fire-and-forget, best-effort;
     [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts),
     [`edge-smtp-transport.ts`](../../services/edge-gateway/src/edge-smtp-transport.ts),
     [`edge-control-plane.ts`](../../services/edge-gateway/src/edge-control-plane.ts)):
     первый резолв кред после старта Edge поднимает соединение заранее, поэтому
     первый ответ менеджера уже идёт по тёплому транспорту. (б) Независимый
     `AbortController`-таймаут у `fetch` в `forwardEgressToEdgeControl`
     (`EDGE_CONTROL_TIMEOUT_MS`, по умолчанию 15с;
     [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)).
     (в) Идемпотентность повтора — уже даёт дедуп `control_id` на Edge
     (повтор возвращает `sent`). Тесты: `edge-email-sender.test.ts`,
     `edge-smtp-transport.test.ts` (warmUp/verify, best-effort, control-plane
     прогрев). **Живая проверка на стенде (2026-07-13):** после ре-деплоя и
     рестарта Edge первое письмо менеджера ушло `sent` и доставлено (до фикса —
     ложный `failed`). **async-ack** (целевой) — по-прежнему отложен.

---

## 4.3-bis. Хранение вложений (реализовано)

> **Статус (2026-07-13): реализовано, покрыто тестами локально И подтверждено
> живьём на стенде.** Сквозная e2e прогнана: письмо с PDF-вложением отправлено на
> `support@lissac-games.online` → Edge IMAP-драйвер забрал и **сохранил байты на
> RF-томе** (`/var/lib/bridge/attachments/<org>/<sha256>`) → ingress → **ядро
> записало строку в `attachments`** с реальным `storage_ref =
> edge-attach://<org>/<sha256>` (mime/size/filename/content_hash совпали) →
> **менеджер скачал** через backend-прокси `GET /api/v1/attachments/:id/content`
> (HTTP 200, `application/pdf`, `Content-Disposition` с именем файла) и
> **полученные байты побайтно совпали** с вложением исходного письма. Прокси
> лениво тянет байты с Edge — резидентность соблюдена.

**Проблема (было).** IMAP-драйвер клал в конверт только метаданные вложения
(`filename`/`mime`/`size`), а `storage_ref` был заглушкой `email-attachment://…`.
Хуже — ядро вообще НЕ персистило вложения (таблица `attachments` существовала, но
в коде не заполнялась), а read-path менеджера их не отдавал. Итог: менеджер не
видел и не мог скачать вложение письма.

**Решения.**

1. **Бэкенд хранения — файловый том на RF (MVP), за интерфейсом
   `EdgeAttachmentStore`.** Выбран файловый том (а не сразу MinIO): резидентность
   ПДн (152-ФЗ) — байты остаются на RF; ноль новой инфраструктуры; полностью
   тестируется локально (tmpdir). Self-hosted S3-совместимый MinIO подключается
   позже тем же интерфейсом без изменений вызывающего кода (S3 сознательно
   отложен). Реализация:
   [`edge-attachment-store.ts`](../../services/edge-gateway/src/edge-attachment-store.ts)
   (`createFilesystemAttachmentStore`).
2. **Резидентность — байты не едут за рубеж заранее.** Вложения физически лежат
   на Edge (RF). Менеджер (App-сторона) скачивает их **лениво**: backend-прокси
   `GET /v1/attachments/:id/content`
   ([`attachment.controller.ts`](../../services/backend/src/modules/communication-core/attachment.controller.ts) +
   [`attachment.service.ts`](../../services/backend/src/modules/communication-core/attachment.service.ts))
   тянет байты с Edge (`GET /internal/edge/attachments?ref=…`,
   [`server.ts`](../../services/edge-gateway/src/server.ts)) **только когда
   менеджер открывает вложение**. «Не тащим байты за рубеж без нужды».
3. **`storage_ref` — непрозрачная строка `edge-attach://<org>/<sha256>`.**
   Content-hash в пути → дедуп (одинаковые байты кладутся один раз). Ядро схему
   НЕ парсит (хранит и отдаёт как есть) — резолвит только Edge. Учтён лимит
   размера (`EMAIL_ATTACHMENT_MAX_BYTES`, дефолт 25 МБ): больше — сохраняются
   только метаданные, приём письма не падает.

**Поток (сверху вниз).**

```
Письмо с вложением (IMAP)
  → edge-imap-mailbox.ts: mailparser даёт байты → EdgeAttachmentStore.put()
    → storage_ref = edge-attach://<org>/<sha256>, size, content_hash
  → edge-email-ingress.ts: attachments[] в конверте C2 (id — детерминированный
    UUID по (messageId, ссылка) для идемпотентности; storage_ref непрозрачен)
  → RF-буфер → туннель → CORE_INGRESS_URL
  → ядро acceptIngress: INSERT INTO attachments (storage_ref как есть,
    ON CONFLICT DO NOTHING — повтор письма не плодит дублей)
  → read-path (listMessages/getMessage): json_agg вложений →
    attachments[{id,name,contentType,sizeBytes,url}], url = /v1/attachments/:id/content
  → manager-workspace: качает blob через API-клиент (tenant-заголовок + cookie
    сессии), а не плоским <a href>; backend-прокси стримит байты с Edge
```

**Изменения ядра — минимальны и аддитивны.** Ядро по-прежнему НЕ понимает схему
`storage_ref` (полностью непрозрачна). Добавлено только: (а) персистентность
`attachments[]` в `acceptIngress`; (б) выдача вложений в read-path; (в) прокси
`GET /v1/attachments/:id/content`. Контракты C1/C2 и форма конверта не менялись.

**Тесты (локально, без стенда).**
- Edge: `edge-attachment-store.test.ts` (put/get, дедуп, лимит, чужой ref),
  `edge-imap-mailbox.test.ts` (сохранение байтов + реальный `storage_ref`;
  oversized → только метаданные), `edge-attachment-resolve.test.ts` (маршрут
  отдаёт байты/404/400), `edge-email-ingress.test.ts` (UUID-id, идемпотентность).
- Backend: `attachment-resolver.service.spec.ts` (резолв+прокси, дерив URL из
  EDGE_CONTROL_URL, 404 при отсутствии байтов, 503 без резолвера; маппинг
  read-path в `url`), `internal-messaging.dto.spec.ts` (нормализация вложений),
  `internal-messaging.spec.ts` (персистентность + дедуп в БД).
- manager-workspace: скачивание через API-клиент (blob) — mock-бэкенд + клиент.

**Инфраструктура.** `docker-compose.rf.yml` — том `bridge-edge-attachments`
(`EMAIL_ATTACHMENT_STORAGE_DIR`); `docker-compose.yml` — `EDGE_ATTACHMENT_URL`
(дефолт — дерив из `EDGE_CONTROL_URL`). Гейт — тот же `EDGE_CHANNEL_DRIVERS=on`.

### Follow-up / остаточный техдолг (после закрытия задачи вложений)

Задача входящих вложений закрыта (реализовано + e2e на стенде PASS). Ниже —
что осознанно НЕ вошло и стоит завести отдельно, чтобы не потерялось:

1. **Retention/GC байтов на RF-томе (техдолг, стоит сделать).** Файлы в
   `EMAIL_ATTACHMENT_STORAGE_DIR` (`bridge-edge-attachments`) сейчас **не
   удаляются никогда** — том растёт безгранично. Нужна политика очистки: по TTL
   и/или по удалению сообщения/диалога (сборщик на Edge, учитывая дедуп по
   content-hash — удалять объект только когда на него не ссылается ни одно
   сообщение). Единственный пункт, который влияет на эксплуатацию.
2. ~~**Исходящие вложения (новая фича, не входила в задачу).**~~ **Реализовано
   (2026-07-13, локально, без стенда).** Менеджер прикрепляет файл к ответу
   клиенту, письмо уходит по SMTP с реальным вложением. Сквозной путь (симметрично
   входящему):
   - **manager-workspace:** в `DialogPage` (email-диалоги) — кнопка «Прикрепить
     файл» + список выбранных файлов; при отправке байты грузятся `POST
     /api/v1/attachments` (клиент `attachments.upload`), дескрипторы со
     `storageRef` кладутся в `POST /messages`
     ([`http.ts`](../../apps/manager-workspace/src/api/client/http.ts),
     [`DialogPage.tsx`](../../apps/manager-workspace/src/presentation/pages/DialogPage.tsx)).
   - **Backend:** `POST /api/v1/attachments`
     ([`attachment.controller.ts`](../../services/backend/src/modules/communication-core/attachment.controller.ts) +
     `AttachmentResolverService.store`) проксирует сырые байты на RF-том Edge
     (`POST /internal/edge/attachments`) и возвращает непрозрачный `storage_ref`
     (резидентность — байты оседают на RF, backend их не хранит). `createMessage`
     сохраняет вложения в таблицу `attachments`; egress
     (`buildC2EgressDelivery`/`egress_dispatch`) несёт `attachments[]` со
     `storage_ref` на Edge.
   - **Edge:** `POST /internal/edge/attachments` (`server.ts`) → `EdgeAttachmentStore.put`
     (дедуп по content-hash, лимит `EMAIL_ATTACHMENT_MAX_BYTES` → 413);
     `edge-email-sender` резолвит `storage_ref` → реальные байты из
     `EdgeAttachmentStore` и вкладывает их в nodemailer `content` (а не `path`),
     с best-effort откатом на ссылку при отсутствии стора/байтов.
   - **Тесты:** edge node:test (upload-маршрут put→get round-trip + дедуп + 413;
     sender резолвит байты в `content` / fallback на `path`), backend jest
     (`AttachmentResolverService.store`, `buildC2EgressDelivery` с вложениями,
     egress-интеграция прокидывает `storage_ref`), manager vitest (upload с
     tenant-заголовком + encoded filename, вложения в теле `POST /messages`).
     Живая e2e на стенде — не прогонялась (техдолг ниже).
3. **Мелочи UX (низкий приоритет).** Inline-превью изображений в ленте (сейчас
   только кнопка-скачивание); понятная подсказка вместо «ошибка», когда вложение
   было oversized (метаданные есть, байтов нет → резолв отдаёт 404).
4. **MinIO/S3 вместо файлового тома** и **настоящий стриминг** больших вложений —
   осознанно отложены на MVP (см. §4.3-bis; интерфейс `EdgeAttachmentStore` готов
   под дроп-ин, лимит 25 МБ буферизуется в памяти).

---

## 5. Что осознанно вне этого плана

- SMS/VK/WhatsApp-каналы — не в приоритете MVP, план их не касается
  (см. §4.4 [`mock-to-production.md`](./mock-to-production.md)).
- k8s/helm-слой и централизованный секрет-менеджер (Vault/KMS) — вне MVP;
  email-креды до их появления живут в `channels.credentials_envelope`
  (envelope-шифрование ключом из env процесса Backend) + локальном
  зашифрованном кэше на Edge (Этап E2), как и Telegram-токен для egress на
  app-стороне.
- Реальный TCP/TLS-сокет самого VPN-туннеля Edge↔App (переход от in-process
  связи к сетевому сокету между физическими серверами, `MP-12`) — общий
  блокер RF-контура, не специфичный для email; этот план добавляет **новый
  тип сообщений** поверх протокола. **Обновление MP-12:** и data-plane
  (Edge→App), и control-plane (App→Edge) теперь ходят по боевому сокету —
  control-plane через `edge-control-transport.ts`/`edge-control-relay.ts`
  (App-сторона, `edge-vpn-app`) и control-listener Edge
  (`EDGE_VPN_CONTROL_LISTEN`), переиспользуя RPC-машинерию `vpn-transport.ts`.
  Осталась только боевая приёмка реального AmneziaWG-сокета на стенде.
  Проброс RF-секретов/`DATABASE_URL` в edge-gateway (`MP-22`) — тоже
  предпосылка, без которой Edge не поднимет ни RF-буфер, ни локальный
  кэш кред.
- Email-плечо SVC-NOTIF (проактивные уведомления по почте, не диалоги
  клиент↔менеджер) — отдельный контур, не входит в этот план.
