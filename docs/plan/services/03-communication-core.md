---
title: План разработки — Communication Core
service: Communication Core
service_id: SVC-CORE
version: 1.0
status: Draft
language: ru-RU
based_on: docs/MessengerBridge_TZ.md (v1.1) §8, §7.10, §11.12, §11.7
master_plan: docs/plan/README.md
---

# План разработки сервиса Communication Core (SVC-CORE)

Communication Core — **сердце платформы** и реализация принципа *Communication
First* (ТЗ §5.1): если решение не улучшает коммуникацию, оно не входит в MVP.
SVC-CORE владеет **жизненным циклом сообщений** (приём → проверка → регистрация →
сохранение → маршрутизация → обработка прикладными сервисами → отправка ответа,
ТЗ §8.3), объединяет сообщения в **диалоги** (Conversation, ТЗ §8.5), выполняет
**идентификацию и объединение клиентов** (identity resolution, ТЗ §8.13) и
гарантирует **порядок** сообщений в рамках Endpoint (ТЗ §7.10) и сквозную
**идемпотентность** доставки (ТЗ §11.12). Сервис — модуль синхронного ядра
(модульный монолит на NestJS, мастер §2), не содержит AI (ТЗ §8.7) и
пользовательских интерфейсов (ТЗ §8.2). SVC-CORE участвует в точках согласования
**CP-1**, **CP-2**, **CP-6**, **CP-7** (мастер §6).

> Ссылки «ТЗ §…» — на техническое задание; «§…» — на мастер-план
> [`docs/plan/README.md`](../README.md); «M0…M5» — вехи (мастер §5); «CP-…» —
> точки согласования (мастер §6); «C1/C2/C7/C9», «SVC-…» — контракты и сервисы
> (мастер §7, §2).

---

## 1. Назначение и границы

**Входит в SVC-CORE:**

- приём, проверка корректности, регистрация и сохранение сообщений (ТЗ §8.2–§8.3);
- управление **Conversation**: создание/поиск диалога, `status`, `last_message_at`
  (ТЗ §8.5);
- **маршрутизация** сообщения (менеджеру / AI / Broadcast / Notification / Workflow /
  внешнему сервису) по конфигурации платформы (ТЗ §8.6), опираясь на Capability
  Model (C6), а не на имя канала (ТЗ §10.6);
- **разрешение личности клиента** и слияние/перенос Endpoint между Client
  (ТЗ §8.13);
- **гарантия порядка** в рамках одного Endpoint/Conversation через
  `sequence_number` и партиционирование single-writer (ТЗ §7.10);
- **сквозная идемпотентность** и дедупликация по `idempotency_key = message_id`
  (ТЗ §11.12);
- журналирование этапов жизненного цикла (ТЗ §8.10) и публикация доменных событий
  прикладным сервисам через транзакционный outbox (мастер §4.10, C-OUT).

**НЕ входит в SVC-CORE (границы):**

- **адаптеры каналов** (Telegram/MAX/VK/WhatsApp/Email/SMS/Web Chat) и обращения к
  внешним API — это SVC-INT (ТЗ §8.8, §10.7); SVC-CORE работает только с
  внутренними сущностями;
- **транспорт до клиента РФ**, буфер и WS Gateway — это SVC-EDGE (ТЗ §7);
- **прямое обращение к БД** извне ядра — доступ к схеме только через Backend, схему
  и миграции поставляет SVC-DATA (мастер §4, §22.3);
- принятие решений на основе AI — делегируется SVC-AI (ТЗ §8.7).

Каноническое определение схемы БД — мастер §4.3/§4.4 (владелец — SVC-DATA);
каноническое определение контрактов — `packages/contracts` (мастер §7). Настоящий
план **не переопределяет** их, а детализирует участок SVC-CORE.

---

## 2. Технологии

| Область | Решение |
|---|---|
| Язык/фреймворк | TypeScript, **NestJS-модуль** `communication-core` внутри `services/backend` (мастер §3), внутренние сервисные интерфейсы NestJS (ТЗ §11.4). |
| Доступ к данным | Только через слой Data Platform (SVC-DATA); PostgreSQL 16, транзакции для «сохранение + outbox» атомарно. |
| Порядок/партиционирование | Single-writer на партицию `endpoint_id`; присвоение `sequence_number`; восстановление порядка по `INDEX(endpoint_id, sequence_number)` (ТЗ §7.10). |
| Идемпотентность | Уникальность `messages.id (= idempotency_key)`; окно дедупликации до подтверждения доставки (ТЗ §11.12). |
| Realtime | WebSocket-события C7 (ТЗ §11.7); фактический транспорт WS — через SVC-EDGE (WebSocket Gateway). |
| Интеграция с вынесенными сервисами | **Транзакционный outbox** `outbox_events` (мастер §4.10, C-OUT): доменные события для SVC-FBP/SVC-AI/SVC-BCAST/SVC-NOTIF без потери согласованности. |
| Тестирование | Jest (unit, `*.spec.ts`), Testcontainers (integration Backend↔PostgreSQL/↔WS, ТЗ §26.4), contract- и e2e-тесты на CP (мастер §8). |

---

## 3. Интерфейсы и контракты

SVC-CORE — **владелец** контрактов **C1** (Message Model) и **C2**
(Ingress/Egress), **совладелец C7** (WS events, вместе с SVC-EDGE/SVC-API).
Ниже — детализация полей и операций; **каноническое определение хранится в
`packages/contracts`** (`message-model/`, `events/`, `openapi/`), semver и
заморозка — по мастер §7.4/§9.3.

### 3.1 Экспортируемые контракты

**C1 — Message Model (каноническая модель сообщения, ТЗ §8.4, поля мастер §4.4).**
Внутренний формат, единый для всех каналов (ТЗ §8.8); НЕ зависит от формата
внешнего API (ТЗ §8.4). Поля:

- `id` — UUID, **= message_id = сквозной `idempotency_key`** (ТЗ §11.12);
- `organization_id` — арендатор (изоляция, ТЗ §22.6);
- `conversation_id`, `client_id`, `endpoint_id`, `channel` — привязки;
- `direction` — `inbound|outbound`;
- `sender_type` — `client|manager|ai|broadcast|system`;
- `sequence_number` — порядок в рамках Endpoint (ТЗ §7.10);
- `type`, `content` (jsonb), `attachments[]` — тип, содержимое, вложения;
- `status` — `received|routed|sent|delivered|failed` (конечный автомат §7);
- `created_at`, `delivered_at`, служебные атрибуты (маршрут, источник).

**C2 — Ingress/Egress (INT ↔ CORE, мастер §7.1).**

- **Ingress** (Adapter → Core, приём): `POST /internal/ingress/messages` — принимает
  сообщение в канонической форме C1 от SVC-INT; идемпотентно по `idempotency_key`;
  ответ фиксирует принятый `message_id`, `conversation_id`, `sequence_number`.
- **Egress** (Core → Adapter, доставка): контракт передачи исходящего сообщения в
  SVC-INT для доставки во внешний канал (ТЗ §8.9); переносит `idempotency_key` и
  `sequence_number`; результат доставки возвращается в
  `message_delivery_attempts` и меняет `status` (ТЗ §10.8).

**C3.conversations / C3.messages (публичный REST, мастер §7.2, префикс `/api/v1`).**

- `GET /conversations` — список диалогов организации (`status`, `last_message_at`);
- `GET /conversations/{id}` — диалог; `GET /conversations/{id}/messages` — история
  (постранично, порядок по `sequence_number`/времени);
- `POST /messages` — создание/отправка сообщения, **идемпотентно** по
  `idempotency_key = id` (ТЗ §11.12); `GET /messages/{id}`.

**C7 — WS-события (Backend → клиенты, ТЗ §11.7, совладение с SVC-EDGE/SVC-API).**
SVC-CORE публикует: `message.created`, `message.status_changed`,
`typing.started`/`typing.stopped`, `client.status_changed`. Транспорт и
переподключение — SVC-EDGE (мастер §7.3).

### 3.2 Потребляемые контракты

| Контракт | От кого | Назначение |
|---|---|---|
| **C2** (Ingress) | SVC-INT | приём входящих из адаптеров каналов. |
| **C6** (Capability Descriptor) | SVC-INT | решения о маршрутизации/форме доставки по возможностям канала (ТЗ §10.6). |
| **C9** (Edge↔App Tunnel) | SVC-EDGE | приём сообщений с `sequence_number` и `idempotency_key`; восстановление порядка и дедупликация (ТЗ §7.9–§7.10, §11.12). |
| Схема БД + миграции | SVC-DATA | таблицы §4.3/§4.4, RLS по `organization_id`, `outbox_events`. |

---

## 4. Модель данных

Таблицы — по мастер §4.3/§4.4 (владелец схемы SVC-DATA, потребители SVC-MWS,
SVC-CHAT, SVC-INT). SVC-CORE использует их так:

| Таблица | Ключевые поля (акцент SVC-CORE) | Появляется |
|---|---|---|
| `clients` | `id`, `organization_id`, `display_name`, `anonymized_at` (обезличивание, ТЗ §22.11). | M1 |
| `communication_endpoints` | `client_id`, `channel`, `external_id`, `verified`; `UNIQUE(organization_id, channel, external_id)`. | M1 |
| `client_identity_links` | `client_id`, `endpoint_id`, `link_type` (`verified_phone\|verified_email\|link_code\|manual`), `evidence`, `reverted_at` — **identity resolution/слияние** (ТЗ §8.13). | M2 |
| `conversations` | `client_id`, **`status`** (`open\|closed\|pending`), **`last_message_at`**; `INDEX(organization_id, client_id)`. | M1 |
| `messages` | **`id` = `idempotency_key`, `UNIQUE(id)`** (дедуп, ТЗ §11.12); **`sequence_number` + `INDEX(endpoint_id, sequence_number)`** (порядок/пропуски, ТЗ §7.10); `direction`, `sender_type`, `status`. | M1 |
| `attachments` | `message_id`, `kind`, `storage_ref`, `mime`, `size`. | M1 |
| `message_delivery_attempts` | `message_id`, `adapter`, `attempt_no`, `status`, `error` — ретраи доставки (ТЗ §10.8, §14.9). | M1 (база) / M4 (полно) |
| `outbox_events` | `aggregate_id`, `event_type`, `payload`, `status` — доменные события ядра (мастер §4.10). | M3 |

**Инварианты SVC-CORE:** (1) один Client — одна Conversation по сопоставленным
Endpoint (ТЗ §8.5); (2) `sequence_number` монотонен в пределах `endpoint_id`;
(3) запись `messages` и `outbox_events` — в одной транзакции.

---

## 5. Поэтапный план

Каждый этап привязан к вехе (мастер §5) и даёт вертикальный срез. Для каждого:
Цель · Задачи · Тесты (unit / integration / e2e) · DoD (единый — мастер §9.4).

### M0 — Контракты и каркас

- **Цель.** Заморозить основу для параллельной разработки смежных сервисов.
- **Задачи.** Определить и зафиксировать в `packages/contracts` **C1 Message Model**
  (поля §4.4) и **C2** (Ingress `POST /internal/ingress/messages` + Egress);
  описать конечный автомат `status`; поднять **мок Ingress** и мок Egress; каркас
  модуля `communication-core` в NestJS.
- **Тесты.** unit — валидация DTO C1, схема события; contract-заготовки INT↔CORE.
- **DoD.** Контракты C1/C2 v1 заморожены (semver), моки в CI зелёные (мастер §9.4).
- **Артефакты M0.** C1 v1.0.0 зафиксирован в
  `packages/contracts/message-model`; C2 Ingress/Egress v1.0.0 — в
  `packages/contracts/openapi/communication-core-c2.openapi.json`; mock
  Ingress/Egress без БД и реальной доставки — в
  `services/backend/src/modules/communication-core`; contract smoke INT↔CORE —
  в `tests/contract`.

### M1 — Вертикальный срез «приём и ответ»

- **Цель.** Клиент пишет → сообщение сохранено → менеджер видит и отвечает →
  ответ уходит на доставку (Communication First, ТЗ §5.1).
- **Задачи.** Реализовать Ingress (C2): приём входящего, проверка (ТЗ §8.3),
  регистрация и сохранение `messages`/`attachments`; **создание/поиск
  Conversation** (ТЗ §8.5) с `status`/`last_message_at`; маршрутизация менеджеру
  (ТЗ §8.6); `GET /conversations`, `GET /conversations/{id}/messages`,
  `POST /messages`; **минимальный Egress** (ответ менеджера → SVC-INT); базовая
  запись `message_delivery_attempts`.
- **Тесты.** unit — переходы `status` (`received→routed→sent`), формирование
  Conversation; integration — Backend↔PostgreSQL (сохранение, изоляция арендатора),
  Backend↔Communication Core (ТЗ §26.4); e2e — «Web Chat: приём и ответ» (в связке
  CP-1).
- **DoD.** Срез M1 проходит e2e; изоляция арендатора и серверная валидация
  (мастер §9.4).

**Статус реализации CP-1.** M1 Communication Core реализован в исполняемом
NestJS/TypeScript-коде (компилируется в `dist/main.js`, issue #189): C2 Ingress
`POST /internal/ingress/messages` и Egress `POST /internal/egress/messages` —
`src/modules/communication-core/internal-messaging.controller.ts` +
`internal-messaging.service.ts` + `internal-messaging.dto.ts`; конечный автомат
`received→routed→sent→delivered/failed` — `message-status.ts`; чтение диалогов и
идемпотентный `POST /messages` — `communication-core-proxy.service.ts` +
`communication-core.controller.ts`. Покрытие: unit
`test/unit/message-status.spec.ts`, `test/unit/internal-messaging.dto.spec.ts`;
end-to-end на реальном Postgres (testcontainers, реальный `AppModule` = код
`dist/main.js`) — `test/integration/internal-messaging.spec.ts`. C2 Egress
сохраняет `channel_type`/`conversation_ref`, чтобы Web Chat adapter доставлял
ответ в ту же сессию CP-1. Прежние прототипные `.mjs`-наборы
(`communication-core.m1.test.mjs`, `tests/integration/communication-core-m1.test.mjs`,
`tests/contract/int-core.m1.contract.test.mjs`) валидируют изолированный
`.mjs`-прототип, а не production-код (см. `docs/audit/backend-mjs-production-audit.md`,
пункты 3 и 12).

### M2 — Identity resolution, порядок, realtime

- **Цель.** Омниканальная единая история, гарантия порядка, обновления realtime.
- **Задачи.** **Identity resolution/слияние** (ТЗ §8.13): поведение по умолчанию
  для неизвестного/анонимного Endpoint; автосвязывание только по верифицированному
  идентификатору (`verified_phone`/`verified_email`/`link_code`); ручное
  объединение с аудитом (ТЗ §23.8) и обратимостью (`client_identity_links.reverted_at`);
  слияние историй по времени и `sequence_number`. **Порядок по Endpoint**
  (ТЗ §7.10): присвоение `sequence_number`, single-writer на партицию, обнаружение
  пропусков. **WS realtime (C7)**: публикация `message.created`,
  `message.status_changed`, `typing.*`, `client.status_changed`.
- **Тесты.** unit — назначение `sequence_number`, логика слияния/«разслияния»
  клиентов, дедупликация по `idempotency_key`; integration — Backend↔PostgreSQL
  (порядок, links), **Backend↔WebSocket** (ТЗ §26.4); e2e — «Telegram: приём и
  ответ» (CP-2).
- **DoD.** Порядок и слияние покрыты тестами; C7 события идут в realtime.

**Статус реализации M2.** M2 Communication Core завершён для CP-2: identity
resolution, endpoint-scoped `sequence_number`, gap detection, C7 публикация и
выбор канала по C6 capabilities покрыты
`services/backend/test/unit/communication-core.m2.test.mjs` и
`tests/integration/communication-core-m2.test.mjs`; сквозной Telegram receive/reply
проверен в `tests/e2e/telegram-cp2.test.mjs`. C2 зафиксирован как
`stable_for_m3` в `packages/contracts/cp2-cp3-freeze.v1.json`.

### M3 — Доменные события для Workflow (outbox)

- **Цель.** Надёжно уведомлять вынесенные сервисы о событиях ядра.
- **Задачи.** Транзакционный **outbox** (`outbox_events`, мастер §4.10, C-OUT):
  публикация доменных событий (новое сообщение, смена статуса, создание диалога)
  для **интеграции с SVC-FBP** (Automation Workflow) и др.; запись сообщения и
  события в одной транзакции; идемпотентная доставка событий из outbox.
- **Тесты.** unit — формирование payload события, атомарность «message+outbox»;
  integration — Backend↔PostgreSQL (outbox publish/replay), фасад к SVC-FBP через
  мок; e2e — участие ядра в сценарии «Workflow (запуск→Node→завершение)».
- **DoD.** События доставляются надёжно; повтор публикации не создаёт дублей.

**Статус реализации M3.** M3 Communication Core завершён для публикации доменных
событий ядра: `conversation.created`, `message.created` и
`message.status_changed` пишутся в `outbox_events` в той же транзакции, что и
создание/изменение агрегата. Детерминированный `event.id` и replay по
`pending -> published` обеспечивают идемпотентную доставку в мок SVC-FBP.
Покрытие: `services/backend/test/unit/communication-core.m3.test.mjs`,
`tests/integration/communication-core-m3.test.mjs` и
`tests/e2e/workflow-cp4.test.mjs`. Для M3 gate outbox-инвариант зафиксирован в
`packages/contracts/cp4-cp5-freeze.v1.json`: replay идемпотентен и не создаёт
дублирующих запусков Workflow. Готовность M4: `outbox_events` остаётся
стабильной основой для Broadcast, Edge и Notification producer-потоков.

### M4 — Сквозная идемпотентность, Broadcast, Edge

- **Цель.** Единый механизм доставки, устойчивость к ретраям/разрывам.
- **Задачи.** **Сквозная идемпотентность** (ТЗ §11.12): дедупликация по
  `idempotency_key = message_id` на всех переходах (клиент → Edge → буфер → Core →
  Adapter), окно дедупликации, полные `message_delivery_attempts` (ТЗ §10.8, §14.9).
  **Интеграция с SVC-BCAST** (CP-6): доставка кампаний **через единый механизм
  ядра** (C1/C2), связь `broadcast_messages ↔ messages`. **Приём от SVC-EDGE**
  (C9, CP-7): восстановление порядка по `sequence_number` и **дедупликация** после
  восстановления соединения/выгрузки буфера (ТЗ §7.9–§7.10).
- **Тесты.** unit — дедупликация при ретраях/дублировании, восстановление порядка
  после разрыва; integration — Backend↔PostgreSQL (дедуп, порядок из буфера),
  contract EDGE↔CORE и BCAST↔CORE; e2e — «Broadcast: доставка кампании» (CP-6),
  «Потеря соединения» (буфер/порядок/дедуп, CP-7, ТЗ §26.6).
- **DoD.** Нет потерь/дублей и перестановок в рамках Endpoint при ретраях и
  разрывах; кампании идут через ядро.

> ⚠️ **Статус в продакшн-сборке (issue #189).** Логика M4 ниже реализована только
> в прототипе `services/backend/src/communication-core/communication-core-m4.mjs`
> и **не** входит в исполняемый NestJS-артефакт `dist/main.js` (Docker запускает
> `node dist/main.js`, собранный из `.ts`). `createEdgeIntakeCoordinator` (C9) и
> `createBroadcastDeliveryCoordinator` (C8) в `.ts` пока не портированы —
> требуют портирования в отдельной задаче. Подробности и таблица вердиктов:
> `docs/audit/backend-mjs-production-audit.md` (пункт 4).

**Статус реализации M4 (прототип `.mjs`).** M4 Communication Core завершён для CP-6 и CP-7.
Сквозная идемпотентность опирается на `messages.id = idempotency_key =
message_id`: повторная передача уже обработанного сообщения отбрасывается на
Ingress, приёме из буфера Edge и при доставке кампаний. `message_delivery_attempts`
пишется полностью — промежуточные неудачные попытки фиксируются **без** перехода
статуса (сообщение остаётся `routed`, т.к. `failed` терминален), финальный исход
переводит сообщение в `sent`/`failed`. **CP-6 (SVC-BCAST):** координатор
`createBroadcastDeliveryCoordinator` принимает канонический C8-черновик
(`C8.BroadcastCoreDeliveryDraft`), фиксирует исходящее broadcast-сообщение
(direction `outbound`, sender_type `broadcast`), связывает `broadcast_messages ↔
messages` и доставляет строго через **C1/C2** ядра — кампания не обходит SVC-CORE.
**CP-7 (SVC-EDGE):** буферизующий шлюз `createBufferedEdgeGateway` (SVC-EDGE)
копит C9-сообщения при разрыве (дедуп по `idempotency_key`, порядок поступления) и
дренажирует их одним батчем; `createEdgeIntakeCoordinator` (SVC-CORE)
восстанавливает порядок по `(endpoint_id, sequence_number)` и повторно
дедуплицирует через единый ingress-путь. Покрытие:
`services/backend/test/unit/communication-core.m4.test.mjs`,
`services/edge-gateway/test/unit/buffered-gateway.test.mjs`,
`tests/integration/communication-core-m4.test.mjs` (Backend↔PostgreSQL: дедуп и
порядок из буфера, связь `broadcast_messages`, журнал попыток),
`tests/contract/m4-core-cp6-cp7.contract.test.mjs` (EDGE↔CORE и BCAST↔CORE через
моки), e2e `tests/e2e/broadcast-cp6.test.mjs` и
`tests/e2e/edge-connection-loss-cp7.test.mjs`. Контракты CP-6/CP-7 (C8↔C1/C2 и
C9↔C1) зафиксированы в `packages/contracts/cp6-cp7-freeze.v1.json`.

### M5 — Нагрузка, деградация, отказы адаптеров

- **Цель.** Стабильность под нагрузкой и предсказуемая деградация.
- **Задачи.** Нагрузочные пробники на приём/маршрутизацию (ориентиры ТЗ §25.11);
  поведение при **отказах адаптеров** (таймауты, ретраи, перевод `status=failed`,
  без блокировки ядра); проверка масштабирования нескольких экземпляров с единой
  моделью данных (ТЗ §8.11); деградация при недоступности AI (ТЗ §8.7).
- **Тесты.** unit — конечный автомат статуса при отказах; integration —
  деградация при недоступном адаптере/AI; e2e — участие в полном наборе ТЗ §26.6
  (регрессия, CP-9).
- **DoD.** Пройдены нагрузка/деградация; критерии приёмки ядра (мастер §9.4, CP-9).

> ⚠️ **Статус в продакшн-сборке (issue #189).** Модуль `communication-core-m5.mjs`
> — прототип: он **не** компилируется в `dist/main.js` и не подключён к реальному
> пути сообщений (даже внутри `.mjs` координаторы исполняются только в `node --test`).
> `createAdapterFailureCoordinator`, `createAiDegradationGuard` и
> `createCommunicationCoreLoadProbe` в `.ts` не портированы — требуют портирования
> в отдельной задаче. Подробности: `docs/audit/backend-mjs-production-audit.md` (пункт 5).

**Статус реализации M5 (прототип `.mjs`).** Добавлен модуль `communication-core-m5.mjs`:
`createCommunicationCoreLoadProbe` измеряет приём/маршрутизацию без новых типов
сообщений, `createAdapterFailureCoordinator` ограничивает вызовы адаптеров
таймаутом/ретраями и переводит финальный отказ в `status=failed`,
`createAiDegradationGuard` возвращает структурированный fallback при недоступном
AI. Для общей PostgreSQL-модели добавлена повторная проверка idempotency после
endpoint-lock: несколько экземпляров ядра используют единый `idempotency_key` и
сохраняют монотонный `sequence_number` в рамках endpoint. Контракты C1/C2/C7 и
route/message-типы не менялись. Покрытие: `communication-core.m5.test.mjs`,
`tests/integration/communication-core-m5.test.mjs`,
`tests/e2e/communication-core-cp9.test.mjs`; порядок запуска и операционные
заметки по пробникам — в `docs/operations/communication-core-m5-load-probes.md`.

---

## 6. Точки согласования

Формулируются явно: ожидания от смежных сервисов · замораживаемый контракт ·
добавляемые межсервисные тесты (мастер §6).

### CP-1 (M1) — «приём и ответ» с SVC-INT(Web Chat), SVC-API, SVC-IDN, SVC-MWS

- **Ожидания.** SVC-INT(Web Chat) шлёт Ingress (C2); SVC-IDN даёт авторизацию/
  сессию; SVC-MWS отображает очередь и переписку; SVC-API — REST-каркас и ошибки.
- **Замораживаем.** **C1** (Message Model), **C2** (Ingress/Egress), **C7** (WS
  events) — в версии v1.
- **Тесты.** e2e **«Web Chat: приём и ответ»**; **contract INT↔CORE** (Ingress).

### CP-2 (M2) — Омниканальность с SVC-INT (Telegram…)

- **Ожидания.** SVC-INT публикует **Capability Model (C6)** и адаптер Telegram;
  SVC-CORE маршрутизирует по возможностям канала (ТЗ §10.6), не по имени канала.
- **Замораживаем.** **C2 + C6** (Capability descriptor).
- **Тесты.** e2e **«Telegram: приём и ответ»**; contract per-adapter (INT↔CORE).

### CP-6 (M4) — Broadcast через ядро с SVC-BCAST

- **Ожидания.** SVC-BCAST формирует получателей и передаёт кампанию на доставку
  **через единый механизм ядра** (C1/C2), не в обход SVC-CORE.
- **Замораживаем.** **C8** (Broadcast) в части сопряжения с **C1/C2**.
- **Тесты.** e2e **«Broadcast: доставка кампании»**; contract BCAST↔CORE.

### CP-7 (M4) — Edge/потеря соединения с SVC-EDGE

- **Ожидания.** SVC-EDGE передаёт сообщения по **C9** с `sequence_number` и
  `idempotency_key`, буферизует при разрыве (ТЗ §7.9) и выгружает после
  восстановления; SVC-CORE восстанавливает порядок и дедуплицирует.
- **Замораживаем.** **C9** (Edge↔App tunnel) в части сопряжения с **C1**.
- **Тесты.** e2e **«Потеря соединения»** (буфер/порядок/дедуп, ТЗ §26.6);
  **contract EDGE↔CORE**.

---

## 7. Стратегия тестирования

Соответствует мастер §8 (пирамида unit/integration/contract/e2e; покрытие
критической логики ядра ≥ 80 %). Специфические проверки SVC-CORE:

- **Порядок при параллельной обработке.** Конкурентный приём по одному
  `endpoint_id` не нарушает монотонность `sequence_number` (single-writer); между
  разными Endpoint взаимный порядок не требуется (ТЗ §7.10).
- **Отсутствие дублей при ретраях.** Повторная передача с уже обработанным
  `idempotency_key = message_id` отбрасывается на каждом переходе (ТЗ §11.12);
  проверка на Ingress, `POST /messages`, Egress и приёме из буфера.
- **Корректность слияния и «разслияния» клиентов.** Автослияние только по
  верифицированному идентификатору; неверифицированные совпадения не сливают
  (ТЗ §8.13); ручное объединение обратимо (`reverted_at`) и пишет аудит (§23.8);
  истории объединяются по времени и `sequence_number`.
- **Восстановление порядка после разрыва.** После выгрузки буфера Edge (C9)
  сообщения одного Endpoint доставляются в исходном порядке без потерь/дублей.
- **Конечный автомат статуса.** Допустимые переходы `received→routed→sent→
  delivered` и `→failed`; недопустимые переходы отклоняются.

Обязательные integration-связки (ТЗ §26.4): Backend↔PostgreSQL,
Backend↔Communication Core, Backend↔WebSocket. E2e-участие — сценарии вех
(мастер §8.2): «Web Chat» и «Работа менеджера» (M1), «Telegram» (M2), «Broadcast»
и «Потеря соединения» (M4).

---

## 8. Риски и зависимости

| Риск / зависимость | Влияние | Митигирование |
|---|---|---|
| **Порядок vs масштабирование vs ретраи** (ТЗ §7.10) | Дубли/перестановки сообщений | Партиционирование по `endpoint_id` (single-writer) + `sequence_number` + сквозной `idempotency_key`; e2e «Потеря соединения» (CP-7). |
| **Ошибочное слияние клиентов** (ТЗ §8.13) | Смешение историй разных людей, утечка ПДн между Client | Автослияние только по верифицированному идентификатору; ручное — обратимо и с аудитом (§23.8); тесты «разслияния». |
| **Рост таблицы `messages`** | Деградация чтения истории/поиска порядка | Индексы `INDEX(endpoint_id, sequence_number)` и по Conversation (мастер §4.4); политика ретенции/архивации в SVC-DATA; постраничная выдача истории. |
| **Согласованность outbox** (мастер §4.10) | Потеря/дубли доменных событий для SVC-FBP/др. | Запись «message + outbox» в одной транзакции; идемпотентная публикация и повтор из outbox; статусы `pending/published/failed`. |
| Зависимость от **SVC-DATA** (схема/миграции) | Блокировка M1 | Критический путь мастер §10.1: SVC-DATA→SVC-CORE→CP-1; работа против замороженной схемы. |
| Зависимость от **SVC-INT/SVC-EDGE** (C2/C6/C9) | Блокировка CP-2/CP-7 | Разработка против моков контрактов до CP; заморозка на CP (мастер §6, §9.3). |
| Отказ адаптера/AI (ТЗ §8.7, §10.8) | Риск блокировки ядра | Деградируемость: таймауты/ретраи в фасадах, `status=failed`, ядро продолжает работу (M5). |
