---
title: Глоссарий Bridge — контракты, сервисы, обозначения
audience: разработчики / QA / аналитики
source_of_truth: packages/contracts/src/registry.ts, docs/plan/telegram-channel-production.md, docs/MessengerBridge_TZ.md
date: 2026-07-11
---

# Глоссарий Bridge

Расшифровка обозначений, встречающихся в коде, планах и логах: контракты `C1…C10`,
идентификаторы сервисов `SVC-*`, этапы/разрывы/чекпоинты и технические термины.

---

## 1. Контракты (`C1…C10`)

**Контракт (contract)** — это заморожённая граница между сервисами: схема сообщения
или API с полями `contract` + `version` (напр. `{"contract":"C2.IngressMessage","version":"1.0.0"}`).
Контракты нумеруются `C<номер>`; источник истины — реестр
[`packages/contracts/src/registry.ts`](../packages/contracts/src/registry.ts).

| ID | Название | Владелец | Что это | Где в коде |
|----|----------|----------|---------|------------|
| **C1** | Canonical Message Model | SVC-CORE | Каноническая модель сообщения ядра: единый вид `message` (id, organization_id, conversation_id, endpoint_id, channel, direction, sender_type, type, content, status, timestamps) + машина статусов `received→routed→sent→delivered/failed`. | [`packages/contracts/message-model/`](../packages/contracts/message-model/) (`C1.CanonicalMessage`) |
| **C2** | Ingress/Egress (INT ↔ CORE) | SVC-CORE | Внутренние конверты обмена «интеграции ↔ ядро»: `C2.IngressMessage` (входящее от клиента), `C2.EgressDelivery` (исходящее на доставку), `C2.DeliveryAttempt` (обратная нога — статус попытки). | [`internal-messaging.dto.ts`](../services/backend/src/modules/communication-core/internal-messaging.dto.ts) |
| **C3** | Backend REST API | SVC-API / SVC-IDN | Публичный REST ядра `/api/v1/*` (OpenAPI). Подтипы: **C3.base** — базовый REST (SVC-API), **C3.auth** — аутентификация (SVC-IDN), **C3.kb** — поиск по базе знаний. `x-contract-id: C3`. | [`openapi.json`](../packages/contracts/openapi/backend-core/openapi.json) |
| **C4** | AI Platform | SVC-AI | Контракт AI-ассистента: `C4.AssistantSuggestRequest`/Response — RAG-подсказки менеджеру (резюме, ответ, перевод, поиск в БЗ). | [`c4.ts`](../packages/contracts/src/c4.ts) |
| **C5** | FBP Engine | SVC-FBP | Flow-Based Programming: схема Workflow (узлы/связи Node/Connection), декларативная «проводка» графа автоматизаций. | [`c5.ts`](../packages/contracts/src/c5.ts), [`c5-workflow.ts`](../packages/contracts/src/c5-workflow.ts) |
| **C6** | Capability Descriptor | SVC-INT | `C6.CapabilityDescriptor` — какие возможности поддерживает канал/адаптер (text, image, buttons, read_receipt, …). | [`c6.ts`](../packages/contracts/src/c6.ts) |
| **C7** | WebSocket Events (Realtime) | SVC-CORE / SVC-API | `C7.WebSocketEvent` — realtime-события менеджеру: `message.created`, `message.status_changed`, `notification.created`, `typing.*`. Публикуются в Redis Stream, доставляются по WS. | [`c7.ts`](../packages/contracts/src/c7.ts), [`c7-realtime-event.publisher.ts`](../services/backend/src/modules/communication-core/c7-realtime-event.publisher.ts) |
| **C8** | Broadcast Platform | SVC-BCAST | `C8.BroadcastCoreDeliveryDraft` — массовые рассылки: SVC-BCAST отдаёт ядру канонический outbound-черновик, ядро доставляет через тот же C2-путь. | [`c8.ts`](../packages/contracts/src/c8.ts) |
| **C9** | Edge/App Tunnel | SVC-EDGE | `C9.EdgeTunnelMessage` / `C9.EdgeTunnelAck` — VPN-туннель Edge(РФ) ↔ App: пересылка входящего из RF-буфера в ядро (`/internal/edge/tunnel/messages`). | [`c9.ts`](../packages/contracts/src/c9.ts) |
| **C10** | Notification Platform | SVC-NOTIF | `C10.Notification` + `C10.NotificationTriggerEvent` — уведомления менеджерам (категория → каналы web/telegram/email/push). | [`c10.ts`](../packages/contracts/src/c10.ts) |

> **C2-конверт vs канонический C1.** Входящее от SVC-INT идёт как **C2.IngressMessage**
> (вложенный `message`, без DB-идентификаторов): у интеграций нет БД, `conversation_id`/
> `endpoint_id` назначает ядро в `acceptIngress`. **C1.CanonicalMessage** — уже
> разрезолвленное сообщение с этими идентификаторами. Edge-туннель (C9) переносит оба вида.

---

## 2. Сервисы (`SVC-*`)

| ID | Сервис | Роль |
|----|--------|------|
| **SVC-API** | backend (REST) | Публичный API `/api/v1`, оркестрация ядра. |
| **SVC-CORE** | communication-core (в backend) | Ядро сообщений: приём/доставка, статусы, RLS, C7. |
| **SVC-IDN** | identity (в backend) | Аутентификация, сессии, Telegram-login. |
| **SVC-INT** | integration-platform | Каналы/адаптеры: приём входящих (getUpdates) и доставка исходящих (per-org токен). |
| **SVC-EDGE** | edge-gateway | РФ Edge Cluster + App-VPN: RF-first буфер, VPN-туннель, C7 WS-фанаут. |
| **SVC-TGC** | clients/telegram-console | Telegram-консоль менеджера: диалоги/ответы/AI и проактивные карточки в чат менеджера. |
| **SVC-MWS** | manager-workspace | Веб-рабочее место менеджера (`:8082`). |
| **SVC-ADMIN** | saas-admin | Панель администратора SaaS (`:8081`, подключение каналов/токенов). |
| **SVC-CHAT** | web-chat | Виджет веб-чата для клиентов (`:8083`). |
| **SVC-AI** | ai-platform | LLM/RAG: подсказки, эмбеддинги, поиск по БЗ (C4). |
| **SVC-FBP** | fbp-engine | Движок Workflow-автоматизаций (C5). |
| **SVC-BCAST** | broadcast-platform | Массовые рассылки (C8). |
| **SVC-NOTIF** | notification-platform | Маршрутизация/доставка уведомлений (C10). |
| **SVC-MOB** | mobile-api | BFF для мобильных клиентов (CP-7, маршрут через Edge для РФ). |
| **SVC-DATA** | data-platform | Данные/аналитика/хранилище. |

---

## 3. Этапы доведения канала Telegram (`T0…T6`)

План: [`docs/plan/telegram-channel-production.md`](plan/telegram-channel-production.md).

| Этап | Что закрывает |
|------|---------------|
| **T0** | Фундамент секрета канала: envelope-шифрование, `ChannelSecretService` в DI (DR-03). |
| **T1** | Регистрация канала + приём токена бота на `:8081/channels`, реальный `getMe`, persist в БД (G-1…G-4). |
| **T2** | Исходящая доставка per-org токеном организации через S2S-резолв секрета (G-6). |
| **T3** | Входящий драйвер (getUpdates long-poll) + маппинг «бот → организация» (G-5). |
| **T4** | Realtime-пуш входящего менеджеру (C7 на приёме, G-7) + проактивные карточки (G-8). |
| **T5** | Боевой Edge-контур: RF-first приземление входящих клиентов РФ через Edge, деградация без потерь. |
| **T6** | Сквозная приёмка CP-2 (клиент↔менеджер↔клиент), мультитенантность, идемпотентность, снятие моков. |

---

## 4. Разрывы (`G-1…G-8`)

Разрывы (**Gaps**) — конкретные места, где до плана канал был замокан/разорван.

| ID | Разрыв | Закрыт этапом |
|----|--------|---------------|
| **G-1** | UI не принимал токен (только `secret://`-ссылку). | T1 |
| **G-2** | Каналы в in-memory `Map`, не в БД; токен не хранился. | T1 |
| **G-3** | `ChannelSecretStore` не вызывался в рантайме. | T0, T1 |
| **G-4** | `:test` не проверял токен реально (нет `getMe`). | T1 |
| **G-5** | Нет входящего драйвера и маппинга «бот → организация». | T3 |
| **G-6** | Egress брал один глобальный `TELEGRAM_BOT_TOKEN`, не per-channel. | T2 |
| **G-7** | `acceptIngress` не публиковал C7 → нет live-пуша менеджеру. | T4 |
| **G-8** | Проактивные карточки SVC-TGC и Telegram-плечо SVC-NOTIF не подключены. | T4 |

---

## 5. Контрольные точки и дорожная карта (`CP-*`, `DR-*`, `MP-*`)

| Обозначение | Значение |
|-------------|----------|
| **CP-1** | Заморозка контрактов M0-gate (C1/C2/C3/C7). |
| **CP-2** | «Telegram: приём и ответ» — сквозной боевой сценарий канала (цель T6). |
| **CP-7** | Маршрут клиентов РФ через Edge Cluster (mobile-api/edge, ТЗ §7.6). |
| **CP-8** | Проактивные уведомления / Telegram-консоль менеджера. |
| **CP-9** | Политика версионирования API: не ломать `/api/v1` (только additive-изменения). |
| **DR-02** | Redis-инфраструктура (стримы C7, консюмеры уведомлений). |
| **DR-03** | Envelope-шифрование секретов каналов (`credentials_envelope`). |
| **DR-04** | Консолидация egress-доставки. |
| **MP-06** | Реальные каналы (без моков). |
| **MP-13** | SVC-TGC (Telegram-консоль). |
| **MP-11 / MP-19** | Push-уведомления / мобильный BFF (MVP2). |
| **MP-20** | Полноценный секрет-менеджер (Vault/KMS) — вне MVP. |

> `§N` в комментариях и планах — ссылки на разделы ТЗ
> [`docs/MessengerBridge_TZ.md`](MessengerBridge_TZ.md) (напр. §7.13/§7.14 — RF-first/Edge,
> §11.12 — идемпотентность доставки, §15 — уведомления, §22.3 — у SVC-INT нет доступа к БД).

---

## 6. Технические термины и аббревиатуры

| Термин | Значение |
|--------|----------|
| **RF-first** | Первичная фиксация ПДн субъектов РФ в РФ-контуре (RF-буфере Edge) **до** пересылки в ядро (152-ФЗ, ТЗ §7.14). |
| **Edge Cluster (РФ)** | edge-gateway в режиме `EDGE_GATEWAY_MODE=edge`: RF-буфер `edge_message_buffer` + шифр payload + VPN-клиент туннеля. |
| **App-VPN** | edge-gateway в режиме `app-vpn`: App-сторона VPN-туннеля, форвардит C9 в backend `/internal/edge/tunnel/messages`. |
| **VPN Tunnel** | защищённый канал Edge(РФ) ↔ App: сеансовый ключ по HKDF от `EDGE_VPN_SESSION_KEY` + app-level mTLS «отпечатки». |
| **RF-буфер** | `edge_message_buffer` в РФ-Postgres: шифртекст, `sequence_number`, `idempotency_key`, `forwarded_at`; авто-дренаж после reconnect. |
| **RLS** | Row-Level Security Postgres: изоляция арендаторов по `organization_id` (`withTenant`, `app.current_organization_id`); `app.is_platform_operator` — кросс-тенантный доступ ядра. |
| **S2S** | Service-to-Service: внутренние `/internal/*`-вызовы без пользовательской сессии (напр. SVC-INT ↔ backend за токеном/реестром каналов). |
| **envelope-шифрование** | Секрет канала хранится как AES-256-GCM-конверт `credentials_envelope` (alg/kid/iv/tag/ciphertext), в БД — только ссылка `credentials_ref`. |
| **per-org токен** | Токен бота **конкретной организации**: единица маршрутизации в обе стороны (входящее определяет org, исходящее уходит этим же токеном). |
| **getUpdates (long-poll)** | Способ приёма Telegram: SVC-INT периодически опрашивает Bot API по токену канала. Альтернатива — webhook (нельзя одновременно). |
| **webhook** | Push-приём Telegram по HTTPS-URL. Взаимоисключим с getUpdates (иначе 409 Conflict). |
| **idempotency_key** | Сквозной ключ (= `message.id`) для дедупликации: повтор апдейта/доставки не двоит сообщение. |
| **`tg-<channel>-<update_id>` → UUID** | Стабильный ключ входящего Telegram: детерминированный UUID (`uuidFromText`), т.к. ядро принимает `message.id` только строгим UUID. |
| **C7 Redis Stream** | `bridge:c7:events` — поток realtime-событий; backend публикует, Edge/WS доставляет менеджеру. |
| **acceptIngress** | Метод ядра: идемпотентный приём входящего, резолв клиента/endpoint/диалога, запись в `messages`, публикация C7. |
| **credentials_ref** | Ссылка на секрет канала вида `secret://<channel_type>/<organization_id>/<label>`; сам токен — в `credentials_envelope`. |
| **M0/M1…M5** | Внутренние вехи зрелости модулей (mock → production), встречаются в комментариях. |

---

## 7. Порты стенда (для справки)

| Сервис | Порт | | Сервис | Порт |
|--------|------|-|--------|------|
| backend (SVC-API) | 3000 | | saas-admin (SVC-ADMIN) | 8081 |
| integration-platform (SVC-INT) | 3005 | | manager-workspace (SVC-MWS) | 8082 |
| notification-platform (SVC-NOTIF) | 3010 | | web-chat (SVC-CHAT) | 8083 |
| edge-gateway РФ (SVC-EDGE) | 3060 | | App-VPN (TCP/WSS) | 3049 / 3050 |
| Postgres (App / РФ) | 5432 / 5433 | | Redis | 6379 |

См. также runbook по развёртыванию и e2e:
[`docs/testing/telegram-rf-edge-e2e-runbook.md`](testing/telegram-rf-edge-e2e-runbook.md).
