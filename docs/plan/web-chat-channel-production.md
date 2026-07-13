---
title: План доведения канала Web Chat до боевого режима
service: Web Chat (Frontend) / Backend / Edge Gateway / Integration Platform / SaaS Administration
service_id: SVC-CHAT · SVC-API · SVC-EDGE · SVC-INT · SVC-ADMIN
version: 1.0
status: In progress (W1–W2 done 2026-07-13; W3–W7 planned)
language: ru-RU
based_on: docs/plan/telegram-channel-production.md, docs/plan/max-channel-production.md, docs/plan/email-channel-production.md, docs/plan/services/13-web-chat.md, docs/plan/mock-to-production-roadmap.md
date: 2026-07-12
---

# План доведения канала Web Chat до боевого режима

Документ детализирует конкретные шаги, чтобы **сквозной боевой сценарий Web Chat**
работал без моков и разрывов, по образцу уже проработанных каналов Telegram
([`telegram-channel-production.md`](./telegram-channel-production.md)) и MAX
([`max-channel-production.md`](./max-channel-production.md)):

- бизнес-клиент **добавляет канал Web Chat своей организации** на странице
  `:8081/channels` (SaaS Administration);
- посетитель пишет из виджета, **менеджер принимает сообщения и отвечает** клиенту;
- на всех этапах работает доставка **«клиент ↔ edge ↔ app ↔ manager»** и обратно;
- **на Edge работает Web Chat** (RF-first приземление ПДн субъектов РФ, 152-ФЗ);
- Web Chat — **не только встраиваемый компонент, но и хостируемая web-страница
  организации** с ид организации в URL (страница со встроенным чатом), что позволяет
  и протестировать компонент, и дать чат организациям без собственного сайта.

Терминология и нумерация наследуются от
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md): `MP-06`
(реальные каналы; §4.4 включает Web Chat в приоритетную четвёрку
Telegram/Email/MAX/Web Chat), `CP-1` («Web Chat: приём и ответ»), `CP-7`
(«Подключение клиентов РФ через Edge Cluster»). Разрывы канала Web Chat нумеруются
`WG-1…WG-15` (Web chat Gap) по аналогии с `G-1…G-8` telegram-плана и `MG-1…MG-11`
MAX-плана.

> **Ограничение документа.** Только план. Кода и диффов нет. Оценки трудозатрат в
> человеко-днях/датах — не приводятся; шаги — логические/зависимостные единицы.

---

## 0. Текущее состояние (базовая линия)

> **Актуализация (2026-07-12, после внедрения почтового сервиса).** Работы по каналу
> Email затронули общий контур egress/edge, на который ссылается этот план. Разрывы
> `WG-1…WG-15` остаются в силе; уточнены формулировки WG-5 и WG-6:
> - `handoffEgress` стал **per-channel**: email уходит на Edge через App→Edge
>   control-plane (`egress_dispatch`,
>   [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts)
>   `forwardEgressDelivery`, ветка `channel_type === "email"`), минуя SVC-INT. Это
>   готовый **прецедент** для W1: `web_chat` аналогично выводится из дефолтной
>   SVC-INT-ветки (у него доставка терминальна по C7/WS).
> - Появился RF-деплой Edge в режиме `edge`
>   ([`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml)) с App→Edge
>   control-plane, C9-туннелем и синхронизацией кред `channel_credentials_sync`. Тот
>   же туннель — рельс для прозрачного REST-транзита Web Chat (W2). Но webchat к нему
>   **не подключён**: нет `REDIS_URL` (C7 Redis→WS мост не стартует), нет сервисов
>   `web-chat`/`backend`/`integration-platform`, нет проброса `/web-chat/*`
>   ([`server.ts`](../../services/edge-gateway/src/server.ts) по-прежнему 404).

Что **уже реально** и переиспользуется, не переписывается:

- Тип канала `web_chat` в каноническом контракте C1 —
  [`message-model/index.ts`](../../packages/contracts/message-model/index.ts)
  (`MESSAGE_CHANNEL.WEB_CHAT`), и в валидации `channel_type` DTO —
  [`integration-gateway.dto.ts`](../../services/backend/src/modules/integration-gateway/integration-gateway.dto.ts)
  (`CHANNEL_TYPES`).
- **Входящее (посетитель → менеджер) — реально:** публичный модуль
  [`web-chat.service.ts`](../../services/backend/src/modules/web-chat/web-chat.service.ts)
  (`createOrResumeSession`, `sendMessage`, `listMessages`): Postgres, RLS
  `withTenant`, идемпотентность по `idempotency_key`, машина статусов,
  `clients`/`communication_endpoints`/`conversations`/`messages`, публикация C7
  `message.created` на приёме
  ([`web-chat.controller.ts`](../../services/backend/src/modules/web-chat/web-chat.controller.ts)).
- **Исходящее (менеджер → посетитель) по C7/WS — реально:**
  [`communication-core-proxy.service.ts`](../../services/backend/src/modules/communication-core/communication-core-proxy.service.ts)
  (`createMessage` → `publishMessageCreated`) → Redis stream `bridge:c7:events` →
  edge-мост [`c7-redis-stream-bridge.ts`](../../services/edge-gateway/src/c7-redis-stream-bridge.ts)
  → WS-канал (фильтрация по organization/conversation) → виджет
  [`realtimeClient.ts`](../../apps/web-chat/src/platform/realtimeClient.ts).
- **Виджет с устойчивостью (CP-7):** outbound-очередь, стабильный
  `idempotency_key`, догон по `sequence_number`, авто-переотправка —
  [`WebChatWidget.tsx`](../../apps/web-chat/src/WebChatWidget.tsx),
  [`outboundQueue.ts`](../../apps/web-chat/src/platform/outboundQueue.ts). Виджет —
  встраиваемый ESM-бандл [`embed.ts`](../../apps/web-chat/src/embed.ts)
  (`mountBridgeWebChat`).
- **Менеджер канал-агностичен** (рендерит по каноническому полю `channel`,
  `CHANNEL_LABELS.web_chat`) — доработок не требует:
  [`DialogPage.tsx`](../../apps/manager-workspace/src/presentation/pages/DialogPage.tsx).
- **UI `:8081/channels`** уже содержит коннектор Web Chat (`widget_origin`,
  `credentials_ref`) — [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx).
- **Схема БД:** каналы и per-tenant секрет —
  [`m2_schema.sql`](../../db/migrations/20260703124000000_m2_schema.sql) (`channels`);
  опциональная email-верификация посетителя —
  [`stage6_web_chat_realtime.sql`](../../db/migrations/20260707000000000_stage6_web_chat_realtime.sql)
  (`web_chat_email_codes`, RLS).
- **RF-контур Edge:** RF-first буфер, VPN-туннель, приём/туннель-маршруты, C7
  Redis→WS мост — [`edge-cluster.ts`](../../services/edge-gateway/src/edge-cluster.ts),
  [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts),
  [`server.ts`](../../services/edge-gateway/src/server.ts).
- Контракт C7 realtime — [`c7.ts`](../../packages/contracts/src/c7.ts)
  (`C7_WS_PATH = "/ws"`, `C7_RECONNECT_SEMANTICS`).

Что **разорвано/замокано** и адресуется этим планом (`WG-1…WG-15`):

| ID | Разрыв | Где | Этап |
|----|--------|-----|------|
| **WG-1** | Нет хостируемой страницы организации `/chat/:organizationId`; standalone-вход монтирует виджет без org id | [`main.tsx`](../../apps/web-chat/src/main.tsx), [`index.html`](../../apps/web-chat/index.html) | W5 |
| **WG-2** | Виджет не читает `organizationId` из URL (ни path, ни query) → хардкод `DEFAULT_ORGANIZATION_ID` | [`apiClient.ts`](../../apps/web-chat/src/platform/apiClient.ts) (`DEFAULT_ORGANIZATION_ID`), [`WebChatWidget.tsx`](../../apps/web-chat/src/WebChatWidget.tsx) | W5 |
| **WG-3** | Edge не проксирует REST `/web-chat/*` (404 вне allowlist); восходящий REST «клиент → edge → app» не реализован | [`server.ts`](../../services/edge-gateway/src/server.ts) | W2 |
| **WG-4** | «Через Edge» = подмена baseUrl + заголовок `x-bridge-edge-tunnel: web_chat`, который на edge не читается и не заворачивается в C9-туннель | [`edgeConnection.ts`](../../apps/web-chat/src/platform/edgeConnection.ts) | W2 |
| **WG-5** | RF-edge в режиме `edge` уже есть ([`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml), для email/MAX-драйверов), но без `REDIS_URL` (C7-мост не стартует), без сервисов `web-chat`/`backend`/`integration-platform` и без REST-транзита `/web-chat/*` — связка «webchat на edge» всё ещё не собрана | [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml), [`docker-compose.yml`](../../deploy/compose/docker-compose.yml) | W2 |
| **WG-6** | `web_chat` идёт по **дефолтной** ветке `forwardEgressDelivery` в SVC-INT-egress, который не может доставить: фантомный «delivered» (dev) или `failed` (prod, `DELIVERY_ALLOW_MOCK_FALLBACK=false`). Email уже выведен на Edge-ветку (`egress_dispatch`) — для `web_chat` такой обход не сделан | [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts) (`forwardEgressDelivery`), [`communication-core-proxy.service.ts`](../../services/backend/src/modules/communication-core/communication-core-proxy.service.ts) | W1 |
| **WG-7** | Адаптер Web Chat в SVC-INT — in-memory заглушка `acceptEgressDelivery`, не подключён к движку доставки (мёртвый код) | [`web-chat-adapter.ts`](../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.ts), [`main.ts`](../../services/integration-platform/src/main.ts) | W1 |
| **WG-8** | C7 realtime тихо деградирует в no-op без Redis и вне `EDGE_GATEWAY_MODE=edge`; в mock-режиме WS подключается, но событий нет | [`c7-realtime-event.publisher.ts`](../../services/backend/src/modules/communication-core/c7-realtime-event.publisher.ts), [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts) | W3 |
| **WG-9** | Продакшн WS fan-out — `mock-ws-channel.ts`; сервер не декодирует входящие WS-кадры (subscribe игнорируется), нет ping/pong keepalive/backpressure | [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts), [`mock-ws-channel.ts`](../../services/edge-gateway/src/mock-ws-channel.ts), [`server.ts`](../../services/edge-gateway/src/server.ts) | W3 |
| **WG-10** | `WebChatService` не сверяется с реестром каналов: сессия для любого `organization_id`, без проверки включённости `web_chat` и без чтения `config` (allowed origins) | [`web-chat.service.ts`](../../services/backend/src/modules/web-chat/web-chat.service.ts) | W4 |
| **WG-11** | Публичные `/web-chat/*` анонимны без Origin/CORS-allowlist, rate-limit и анти-абьюза | [`web-chat.controller.ts`](../../services/backend/src/modules/web-chat/web-chat.controller.ts) | W4 |
| **WG-12** | Dev-режим фабрикует ответ менеджера (MSW), маскируя реальную петлю | [`mocks/handlers.ts`](../../apps/web-chat/src/mocks/handlers.ts) | W6 |
| **WG-13** | Email-верификация посетителя готова в бэкенде + таблица, но виджет её не вызывает, UI нет (мёртвая фича) | [`web-chat.service.ts`](../../services/backend/src/modules/web-chat/web-chat.service.ts), [`apiClient.ts`](../../apps/web-chat/src/platform/apiClient.ts) | W6 |
| **WG-14** | Вложения (image/file) заявлены в C6-дескрипторе, но не реализованы сквозняком (бэкенд хранит только `text`) | [`web-chat-adapter.ts`](../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.ts), [`web-chat.service.ts`](../../services/backend/src/modules/web-chat/web-chat.service.ts) | W6 |
| **WG-15** | Виджет дублирует контрактные типы C7 вместо импорта `packages/contracts` (риск рассинхрона) | [`types.ts`](../../apps/web-chat/src/types.ts) | W6 |

> **Не разрыв.** C7 realtime на ingress и рендер у менеджера канал-агностичны и уже
> работают — менеджер видит входящее Web Chat вживую и отвечает без доработок ядра
> и manager-workspace. Отмечено для полноты.

---

## 1. Ключевое архитектурное решение

Web Chat принципиально отличается от Telegram/MAX/Email: у него **нет внешнего API
для доставки**. «Клиент» — браузерный виджет, который по REST общается с ядром и
получает ответы по C7 WebSocket. Отсюда решения:

- **Web Chat остаётся app-native realtime-каналом, а не edge-owned драйвером.**
  Входящее (посетитель → app) — синхронный REST (`sessions`/`messages`/история);
  исходящее (app → посетитель) — **терминальная доставка по C7/WS** (не через
  SVC-INT-egress). Адаптер `web-chat` в SVC-INT сохраняется только как источник
  нормализации/C6 (по образцу email-адаптера «для C6, но SVC-INT его не
  диспетчеризует»); его egress-заглушка снимается.
- **«На edge работает Web Chat» реализуется как прозрачный edge-транзит REST/WS**
  (reverse-proxy `/api/v1/web-chat/*` и WS `/ws` поверх C9-туннеля), а **не** как
  бот/поллер на edge. Нисходящий WS-контур уже есть (Redis→мост→WS); достраивается
  восходящий REST-транзит и деплой edge перед виджетом.
- **Хостируемая страница организации `/chat/:organizationId`** — часть SVC-CHAT:
  та же кодовая база виджета, но с чтением org id из URL и брендингом. Служит и
  стендом для встраиваемого компонента, и «чатом организациям без сайта».

```
ВХОДЯЩЕЕ (посетитель → менеджер):
  Посетитель в виджете (страница /chat/:orgId ИЛИ встроенный компонент)
    → REST POST /api/v1/web-chat/{sessions,messages}                 [есть]
    → Edge: прозрачный reverse-proxy REST → C9-туннель → app         [W2]
    → WebChatService.sendMessage: persist inbound (received)         [есть]
        · проверка включённости web_chat + allowed origins           [W4]
    → publishMessageCreated → C7 Redis Stream                        [есть]
    → Edge C7 WS → manager-workspace (live)                          [есть]

ИСХОДЯЩЕЕ (менеджер → посетитель):
  manager-workspace
    → Backend POST /messages (outbound, routed)                     [есть]
    → publishMessageCreated → C7 Redis Stream                       [есть]
    → Edge: c7-redis-stream-bridge → боевой C7 WS-канал             [W3]
    → WS /ws → виджет (рендер ответа)                               [есть]
    · handoffEgress для web_chat ОТКЛЮЧЁН (доставка терминальна по WS) [W1]
```

Ключевая мысль: **единица маршрутизации Web Chat — `organization_id` + `conversation`/
`visitor_session`**, а не токен бота. Edge для Web Chat — прозрачный транспорт (REST
вверх, WS вниз), а не владелец канала.

---

## 2. Этапы и последовательность

Граф зависимостей (ребро = «нужно раньше»):

```
W1 (исходящее без фантомного egress, WG-6,7) ── независим
W2 (прозрачный edge-транзит REST + деплой edge, WG-3,4,5) ─┐
W3 (боевой C7 realtime/WS, WG-8,9) ────────────────────────┤ (edge/realtime контур, параллельно)
W4 (регистрация ↔ рантайм + безопасность публичных ручек, WG-10,11)
W5 (страница организации /chat/:orgId + org id из URL, WG-1,2) ── опирается на W4 (резолв org)
W6 (снятие моков, довод фич, WG-12,13,14,15)
Все ──────→ W7 (сквозная приёмка «Web Chat: приём и ответ», CP-1/CP-7)
```

Параллелизуемость: **W1** независим и делается первым (быстрое устранение ложных
статусов). Edge/realtime-контур **W2 и W3** ведётся параллельно, синхронизируя точку
стыка в W7. **W4** независим; **W5** опирается на резолв организации из W4.

---

### Этап W1 — Исходящее без фантомного egress (WG-6, WG-7)

**Цель.** Единственный путь доставки ответа посетителю — C7/WS; убрать ложные
статусы и мёртвый egress.

**Задачи.**
1. Исключить `web_chat` (и другие realtime/direct-каналы) из внешнего egress — по
   образцу уже сделанной email-ветки: либо не вызывать `handoffEgress` в
   `createMessage`
   ([`communication-core-proxy.service.ts`](../../services/backend/src/modules/communication-core/communication-core-proxy.service.ts)),
   либо добавить в `forwardEgressDelivery`
   ([`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts),
   рядом с веткой `channel_type === "email"`) короткое замыкание для `web_chat`.
   Для таких каналов доставка терминальна по факту публикации C7.
2. Определить машину статусов Web Chat без egress: `routed` → (`delivered` по факту
   доставки WS / ack виджета) без прохода через `sent` во внешнем адаптере.
3. Снять egress-заглушку адаптера
   [`web-chat-adapter.ts`](../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.ts)
   (`acceptEgressDelivery`, in-memory массив) и `isWebChatEgressDelivery`; оставить
   только inbound-нормализацию/C6 или пометить весь адаптер как «C6-only».

**DoD.**
- Ответ менеджера в Web Chat доходит до посетителя по WS; статус в ядре не
  становится `failed`/фиктивным `delivered` из-за SVC-INT.
- Нет вызова SVC-INT-egress для `web_chat` ни при каком профиле; нет warning'ов
  «adapter_missing»/mock-fallback по этому каналу.

**Тесты.** Юнит на ветвление egress в `createMessage` (web_chat не хендофится);
интеграционный: outbound web_chat → только C7 publish, без `/internal/delivery/dispatch`.

**Статус реализации W1 (2026-07-12): выполнено.**
- **Ветвление egress (задачи 1–2).** Введён предикат `isDirectRealtimeChannel`
  (+`DIRECT_REALTIME_CHANNELS`) в
  [`internal-messaging.service.ts`](../../services/backend/src/modules/communication-core/internal-messaging.service.ts).
  `createMessage`
  ([`communication-core-proxy.service.ts`](../../services/backend/src/modules/communication-core/communication-core-proxy.service.ts))
  не вызывает `handoffEgress` для realtime/direct-каналов; сам `handoffEgress`
  дополнительно замыкается для таких каналов **до** перехода `routed→sent` (у
  источника, покрывает и внутренний `/internal/egress/messages`): статус остаётся
  `routed`, C2.EgressDelivery не строится к доставке, попытка не фиксируется,
  SVC-INT не вызывается. WS-ack `routed→delivered` — этап W3.
- **Снятие egress-заглушки адаптера (задача 3).** Из
  [`web-chat-adapter.ts`](../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.ts)
  удалены `acceptEgressDelivery`, `getChannelDeliveries`, `normalizeOutgoingWebChatDelivery`,
  `isWebChatEgressDelivery`, egress-метрики и in-memory буфер; адаптер помечен
  **inbound/C6-only** и в движок доставки SVC-INT не регистрируется.
- **Тесты.** Backend unit `direct-realtime-channel.spec.ts` (предикат) — зелёный;
  backend integration-кейс «web_chat egress → routed, SVC-INT не вызван, попыток
  нет» добавлен в
  [`internal-messaging.spec.ts`](../../services/backend/test/integration/internal-messaging.spec.ts)
  (гоняется в CI-профиле Testcontainers). Integration-platform — tsc чисто, весь
  набор **114/114** (обновлены unit/integration-тесты web-chat-адаптера под
  inbound/C6-only). Backend unit **164/164**, backend `tsc --noEmit` — без новых
  ошибок.

---

### Этап W2 — Прозрачный edge-транзит REST и деплой edge (WG-3, WG-4, WG-5)

**Цель.** Восходящий REST «клиент → edge → app» реально идёт через Edge; связка
собрана в деплое.

**Задачи.**
1. Реализовать на Edge прозрачный проброс REST `/api/v1/web-chat/*` в ядро поверх
   C9-туннеля/кластера ([`server.ts`](../../services/edge-gateway/src/server.ts),
   [`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts)): маршрут
   читает `x-bridge-edge-tunnel: web_chat`, заворачивает запрос в туннель к app,
   возвращает ответ синхронно. Идемпотентность (`idempotency-key`) сохраняется.
   Рельс уже есть — тот же App↔Edge C9-туннель, что несёт email-`egress_dispatch` и
   `channel_credentials_sync`; отличие Web Chat — синхронный запрос/ответ, а не
   fire-and-forget.
2. Согласовать со стороной виджета: `edgeBaseUrl`/`x-bridge-edge-tunnel`
   ([`edgeConnection.ts`](../../apps/web-chat/src/platform/edgeConnection.ts)) теперь
   реально обслуживаются edge (а не только подменяют базу).
3. Деплой: RF-edge в режиме `edge` уже поднят
   ([`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml)) для
   email/MAX-драйверов — дособрать под Web Chat: добавить `REDIS_URL` (для C7
   Redis→WS моста, W3), маршрутизацию `web-chat`-виджета на этот edge
   (`VITE_BRIDGE_EDGE_BASE_URL`) и REST-транзит; при необходимости — reverse-proxy
   (nginx/traefik) как явный слой. Зафиксировать выбранную топологию в README деплоя.

**DoD.**
- REST-запросы виджета (`sessions`/`messages`/история) проходят «клиент → edge →
  app» и обратно; app недоступен виджету напрямую в RF-топологии.
- WS `/ws` и REST идут через один edge-контур; «· через Edge» соответствует
  действительности.

**Тесты.** Интеграционный edge: REST `/web-chat/*` через туннель к ядру-дублёру
(проброс + идемпотентность); проверка 404→200 на ранее непроксируемых путях.

**Статус реализации W2 (2026-07-13): выполнено (транзит + деплой-обвязка;
финальная RF-топология — операторская настройка).**
- **Прозрачный REST-транзит (задачи 1–2).** В edge-сервере
  ([`server.ts`](../../services/edge-gateway/src/server.ts)) добавлен проброс
  `/api/v1/web-chat/*` → ядро (App): читает тело, переносит сквозные заголовки
  (`idempotency-key`, `x-bridge-edge-tunnel`, `content-type`, …), форвардит
  исходный URL и зеркалит статус/тело. Включается опцией `webChatBackendUrl`
  ([`edge-runtime.ts`](../../services/edge-gateway/src/edge-runtime.ts):
  `EDGE_WEB_CHAT_BACKEND_URL`) в обоих режимах (mock/edge); без неё — прежний 404
  (поведение живого edge не меняется). **Решение по WG-4:** транзит идёт
  HTTP-reverse-proxy'ом поверх **сетевого** VPN-туннеля (AmneziaWG), а не
  приложенческим C9-RPC — контракты C3.messages/C1 и идемпотентность не меняются,
  их держит ядро (`WebChatService`). Виджет уже слал `x-bridge-edge-tunnel: web_chat`
  и `edgeBaseUrl` — теперь они реально обслуживаются edge (задача 2 без правок
  фронта).
- **Деплой-обвязка (задача 3).** В RF-компоуз
  ([`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml)) и
  [`.env.rf.example`](../../.env.rf.example) добавлены `EDGE_WEB_CHAT_BACKEND_URL`
  (база ядра по WG) и `REDIS_URL`/`C7_REALTIME_*` (рельс C7 Redis→WS моста;
  фактический старт моста финализируется в W3). Значения по умолчанию пустые —
  оператор задаёт адреса App-стороны по WG; маршрутизация `web-chat`-виджета на RF-edge
  (`VITE_BRIDGE_EDGE_BASE_URL`) и хостинг страницы — совместно с этапом W5.
- **Тесты.** Новый edge integration
  [`web-chat-proxy.test.ts`](../../services/edge-gateway/test/integration/web-chat-proxy.test.ts):
  POST `/web-chat/sessions` и GET истории проксируются в ядро-дублёр с сохранением
  пути/query/тела и сквозных заголовков; повтор с тем же `idempotency-key`
  прозрачен (дедуп — на ядре); без `webChatBackendUrl` путь остаётся 404. Весь
  edge-набор **155/155**, `tsc` — чисто.

**Осознанно вне W2 (переходит в W3/W5):** боевой C7 WS-канал вместо `mock-ws`,
жёсткая зависимость от Redis и старт C7-моста (W3); хостируемая страница
организации и сборка виджета под RF-edge (W5).

---

### Этап W3 — Боевой C7 realtime / WS (WG-8, WG-9)

**Цель.** Realtime не деградирует молча; продакшн-WS вместо мока.

**Задачи.**
1. Заменить/переименовать
   [`mock-ws-channel.ts`](../../services/edge-gateway/src/mock-ws-channel.ts) на
   боевой C7 WS-канал: декодирование входящих WS-кадров (обработка `subscribe`,
   ping/pong keepalive, close), backpressure, авторизация подписки по
   `visitor_session`/`conversation`
   ([`server.ts`](../../services/edge-gateway/src/server.ts)).
2. Сделать Redis обязательным для realtime в edge/prod: fail-fast при отсутствии
   `REDIS_URL` в `EDGE_GATEWAY_MODE=edge` (сейчас RF-edge
   [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml) стартует
   **без** `REDIS_URL` → `c7StreamBridge` не создаётся, событий нет); publisher-no-op
   без Redis
   ([`c7-realtime-event.publisher.ts`](../../services/backend/src/modules/communication-core/c7-realtime-event.publisher.ts))
   переводится в явную ошибку/метрику в проде.
3. Видимое состояние деградации: health/метрики realtime-контура; виджет уже
   показывает `offline/reconnecting` — связать с реальным состоянием.

**DoD.**
- В боевом профиле отсутствие Redis/edge-mode не даёт «тихого» отсутствия realtime —
  оно диагностируется.
- WS-подписка обрабатывает subscribe/keepalive; события scoped по
  organization/conversation (изоляция арендаторов сохранена).

**Тесты.** Юнит на декодер WS-кадров и keepalive; интеграционный: publish→WS
доставка одному конкретному conversation, отсутствие утечки в чужой; проба fail-fast
без Redis.

---

### Этап W4 — Регистрация канала ↔ рантайм и безопасность публичных ручек (WG-10, WG-11)

**Цель.** Добавление канала бизнес-клиентом влияет на рантайм; публичные эндпоинты
защищены.

**Задачи.**
1. `createOrResumeSession`
   ([`web-chat.service.ts`](../../services/backend/src/modules/web-chat/web-chat.service.ts))
   проверяет, что у организации есть **включённый** канал `web_chat`, и читает его
   `config` (например `widget_origin`); сессия не создаётся для организации без
   активного канала.
2. Валидация `Origin`/CORS по allow-list из `config.widget_origin`; для встраивания —
   публичный widget-key вместо «любого org id».
3. Rate-limit и анти-абьюз на `/web-chat/*`
   ([`web-chat.controller.ts`](../../services/backend/src/modules/web-chat/web-chat.controller.ts)):
   ограничение на создание сессий/сообщений с одного источника.
4. Связать коннектор Web Chat в
   [`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx)
   с тем, что реально требуется рантайму (origin, widget-key), и `:test` —
   с проверкой доступности виджет-эндпоинта.

**DoD.**
- Сессия Web Chat создаётся только для организации с включённым каналом; запросы с
  неразрешённого origin отклоняются.
- Публичные ручки имеют rate-limit; злоупотребление ограничено.

**Тесты.** Интеграционный: сессия для org без канала → отказ; запрос с чужого
origin → отказ; rate-limit срабатывает; happy-path с валидным каналом/origin.

---

### Этап W5 — Страница организации `/chat/:organizationId` и org id из URL (WG-1, WG-2)

**Цель.** Web Chat — не только компонент, но и хостируемая страница организации с ид
в URL.

**Задачи.**
1. Добавить в `apps/web-chat` разбор `organizationId` из URL (path `/chat/:orgId`
   и/или query) — вход [`main.tsx`](../../apps/web-chat/src/main.tsx); прокинуть в
   `WebChatWidget` вместо хардкода `DEFAULT_ORGANIZATION_ID`
   ([`apiClient.ts`](../../apps/web-chat/src/platform/apiClient.ts)).
2. Хостируемая страница организации: маршрут `/chat/:organizationId`, монтирующий
   виджет, с брендингом/заголовком организации; SPA-fallback в контейнере `web-chat`.
   Страница служит и стендом для встраиваемого компонента, и «чатом для организаций
   без сайта».
3. Встраивание: поддержать выбор организации через URL-параметр/атрибут, а не только
   через JS-опции mount ([`embed.ts`](../../apps/web-chat/src/embed.ts)).
4. Деплой: раздача `/chat/:organizationId` из контейнера `web-chat`; прокинуть
   `edgeBaseUrl`.

**DoD.**
- По адресу `…/chat/<organizationId>` открывается рабочий чат нужной организации без
  правки кода/пересборки.
- Встраиваемый компонент и хостируемая страница используют один код и один
  edge-контур.

**Тесты.** Юнит на парсинг org id из URL; e2e (Playwright, по образцу
[`web-chat.cp7.spec.ts`](../../apps/web-chat/test/e2e/web-chat.cp7.spec.ts)):
открытие страницы организации → отправка → ответ менеджера.

---

### Этап W6 — Снятие моков и довод фич (WG-12, WG-13, WG-14, WG-15)

**Цель.** Убрать мок-петли и «мёртвые» фичи, закрыть рассинхрон типов.

**Задачи.**
1. Dev-режим: заменить фабрикацию ответа менеджера в
   [`mocks/handlers.ts`](../../apps/web-chat/src/mocks/handlers.ts) реальной связкой
   (backend+redis+edge) либо чётко изолировать как demo-профиль, не выдающий себя за
   рабочую петлю.
2. Email-верификация посетителя (WG-13): либо вывести в UI виджета
   (`startEmailCode`/`verifyEmailCode` уже есть в бэкенде и таблице
   [`web_chat_email_codes`](../../db/migrations/20260707000000000_stage6_web_chat_realtime.sql)),
   либо явно вынести из скоупа и снять бэкенд/таблицу.
3. Вложения (WG-14): реализовать `image`/`file` сквозняком (виджет → бэкенд →
   менеджер) или убрать из C6-дескриптора Web Chat, чтобы capability не заявляла
   нереализованное.
4. Импортировать общие типы C7/сообщений из
   [`packages/contracts`](../../packages/contracts/src/c7.ts) вместо дубликата
   [`types.ts`](../../apps/web-chat/src/types.ts) (WG-15).

**DoD.**
- В `npm run dev` не создаётся иллюзии рабочего менеджера; demo-режим помечен явно.
- Нет заявленных, но нереализованных возможностей; типы C7 — из общего контракта.

**Тесты.** Юнит/интеграция под выбранный объём (email-UI ИЛИ его снятие; вложения ИЛИ
их снятие из C6); проверка сборки виджета после перехода на общие типы.

---

### Этап W7 — Сквозная приёмка «Web Chat: приём и ответ» (CP-1, CP-7)

**Цель.** Подтвердить весь путь без моков и разрывов.

**Задачи.**
1. e2e-сценарий: посетитель на странице организации `/chat/:orgId` пишет →
   сообщение доходит до manager-workspace в реальном времени → менеджер отвечает →
   ответ приходит посетителю в виджет; статусы фиксируются.
2. Через Edge: весь путь идёт «клиент ↔ edge ↔ app ↔ manager» (REST вверх, WS вниз),
   с `EDGE_GATEWAY_MODE=edge` и Redis.
3. Мультитенантность: две организации — изоляция входящих и исходящих (в т.ч. по WS).
4. Идемпотентность: повтор отправки по `idempotency_key` не двоит; догон по
   `sequence_number` без пропусков.
5. Деградация (CP-7): разрыв канала до Edge → буферизация реплики виджетом →
   восстановление → авто-переотправка без дублей.

**DoD (сквозной).**
- Бизнес-клиент добавил канал Web Chat на `:8081/channels`; канал `connected`.
- Посетитель со страницы организации написал → менеджер увидел вживую → ответил →
  посетитель получил ответ.
- Весь путь через Edge; изоляция арендаторов, идемпотентность и деградация
  подтверждены тестами.

**Тесты.** e2e (по образцу
[`t6-cp2-telegram-e2e.integration.test.ts`](../../services/integration-platform/test/integration/t6-cp2-telegram-e2e.integration.test.ts)
и [`m6-cp-max-e2e.integration.test.ts`](../../services/integration-platform/test/integration/m6-cp-max-e2e.integration.test.ts))
+ edge e2e (REST-транзит + WS) + виджет e2e CP-7
([`web-chat.cp7.spec.ts`](../../apps/web-chat/test/e2e/web-chat.cp7.spec.ts)).

---

## 3. Сводка «разрыв → этап → критерий закрытия»

| Разрыв | Этап | Критерий закрытия |
|--------|------|-------------------|
| WG-6 (фантомный egress web_chat) | W1 | web_chat не хендофится в SVC-INT; доставка терминальна по C7/WS |
| WG-7 (заглушка адаптера egress) | W1 | Egress-заглушка снята; адаптер — C6/normalize-only |
| WG-3 (edge не проксирует REST) | W2 | REST `/web-chat/*` идёт «клиент → edge → app» через туннель |
| WG-4 («через Edge» фиктивно) | W2 | Заголовок туннеля реально обслуживается edge |
| WG-5 (webchat не собран на RF-edge) | W2 | RF-edge дособран под Web Chat (Redis + транзит `/web-chat/*`); топология задокументирована |
| WG-8 (тихая деградация realtime) | W3 | Без Redis/edge-mode — явная ошибка/метрика, не no-op |
| WG-9 (mock-ws в проде) | W3 | Боевой C7 WS-канал: subscribe/keepalive/backpressure |
| WG-10 (регистрация оторвана) | W4 | Сессия только для org с включённым web_chat; читается config |
| WG-11 (публичные ручки без защиты) | W4 | Origin-allowlist + rate-limit на `/web-chat/*` |
| WG-1 (нет страницы организации) | W5 | `/chat/:organizationId` открывает рабочий чат организации |
| WG-2 (org id не из URL) | W5 | Виджет читает `organizationId` из URL |
| WG-12 (dev-мок менеджера) | W6 | Нет иллюзии рабочего менеджера в dev; demo помечен |
| WG-13 (email-верификация мертва) | W6 | Email-UI выведен ИЛИ снят из скоупа |
| WG-14 (вложения не реализованы) | W6 | Вложения сквозняком ИЛИ сняты из C6 |
| WG-15 (дубль типов C7) | W6 | Виджет импортирует типы из `packages/contracts` |
| Сквозная приёмка | W7 | e2e «Web Chat: приём и ответ» через Edge зелёный |

---

## 4. Что переиспользуется без изменений

Контракт C1/C2/C7 и enum `web_chat`; capability-профиль Web Chat (C6); DTO
`channel_type`; таблица `channels` + RLS; ядро `WebChatService` (входящее) и
`createMessage`/`publishMessageCreated` (исходящее); C7 realtime менеджеру на ingress;
manager-workspace (канал-агностичен); RF-буфер, VPN-туннель и C7 Redis→WS мост Edge;
устойчивость виджета CP-7 (outbound-очередь, идемпотентность, догон по
`sequence_number`); встраиваемый бандл `embed.ts`.

---

## 5. Риски и решения к принятию

- **Робастность egress до снятия (W1).** Пока `web_chat` не выведен из внешнего
  egress, он подвержен тому же классу дефекта, что зафиксирован по email (cold-start
  → ложный `failed`, см. [`email-channel-production.md`](./email-channel-production.md)).
  W1 закрывает это в корне — доставкой по C7/WS без внешнего адаптера.
- **Транзит REST через Edge (W2): синхронный проброс vs RF-first ingest.** У Web Chat
  запрос/ответ синхронны (сессии, история), поэтому выбирается прозрачный
  reverse-proxy поверх туннеля, а не асинхронный `cluster.ingest` (как у MAX/email).
  Решение и семантика тайм-аутов/ретраев фиксируются в начале W2.
- **Где живёт reverse-proxy.** В самом edge-gateway (новый маршрут) или отдельным
  слоем (nginx/traefik) — выбрать в W2 и отразить в деплое; влияет на TLS/термирование.
- **Модель идентификации организации (W4/W5).** «Любой org id» → включённость канала
  + `widget_origin`/публичный widget-key. Согласовать с UI `:8081/channels` и
  встраиванием.
- **Redis как жёсткая зависимость realtime (W3).** В проде отсутствие Redis — ошибка,
  не тихая деградация; согласовать с профилями dev/CI, где realtime может быть off.
- **ПДн РФ (CP-7).** Первичная фиксация входящих субъектов РФ — в RF-контуре; порядок
  «клиент → Edge → app» обязателен для таких клиентов (ТЗ §7.13/§7.14).
- **Совместимость с заморозкой C2/C6.** Изменения касаются транспорта, хранения и
  фронтенда, не публичных контрактов C1/C2/C6; при необходимости правок — через
  процедуру заморозки (§6 роадмапа).
- **Судьба email-верификации и вложений (W6).** Оба — «вывести или снять»; решение
  влияет на объём W6 и на C6-дескриптор.

---

## 6. Что осознанно вне этого плана

- Пуш-уведомления/проактивные карточки менеджеру для Web Chat — вне сквозного ядра
  «приём и ответ».
- SMS/VK/WhatsApp каналы (§4.4 роадмапа — не приоритет).
- Полноценный секрет-менеджер с авто-ротацией и аудитом (`MP-20`, вне MVP).
- Богатый редактор/файлохранилище вложений сверх минимального `image`/`file`
  (если вложения вообще выбираются к реализации в W6).

---

*Документ детализирует боевой путь канала Web Chat и подчиняется мастер-плану
[`docs/plan/README.md`](./README.md) и роадмапу
[`mock-to-production-roadmap.md`](./mock-to-production-roadmap.md). Структурно
повторяет эталоны [`telegram-channel-production.md`](./telegram-channel-production.md)
и [`max-channel-production.md`](./max-channel-production.md). При расхождении со
сквозными решениями приоритет у мастер-плана; при расхождении с требованиями — ТЗ
[`docs/MessengerBridge_TZ.md`](../MessengerBridge_TZ.md).*
