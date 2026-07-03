---
title: Пятая серия промптов для параллельного выполнения этапа M4
subtitle: Последовательность пятого этапа и набор задач для массовых коммуникаций, Edge/ПДн и уведомлений — Broadcast, Edge + VPN Tunnel, Notification (CP-6, CP-7, CP-8)
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/README.md (v1.0)
---

# Пятая серия промптов для параллельного выполнения этапа M4

Документ отвечает на issue #116: анализирует план, фиксирует порядок выполнения и
даёт пятую серию промптов для параллельного прохождения пятого этапа. Он
продолжает первую серию
[`parallel-stage-1-prompts.md`](./parallel-stage-1-prompts.md) (этап M0), вторую
серию [`parallel-stage-2-prompts.md`](./parallel-stage-2-prompts.md) (этап M1),
третью серию [`parallel-stage-3-prompts.md`](./parallel-stage-3-prompts.md)
(этап M2) и четвёртую серию
[`parallel-stage-4-prompts.md`](./parallel-stage-4-prompts.md) (этап M3).

Под «пятым этапом» здесь понимается **M4 — Массовые коммуникации + Edge/ПДн** из
[`docs/plan/README.md`](./README.md): доставляются Broadcast-кампании **через
единый механизм ядра**, трафик РФ идёт через **Edge + VPN Tunnel** с
буферизацией, восстановлением порядка и дедупликацией (RF-first), а сотрудники
получают **уведомления** в Web и Telegram Console. Этап замыкается на **трёх**
точках согласования: **CP-6** — «Broadcast: доставка кампании» (SVC-BCAST +
SVC-CORE + SVC-INT, заморозка **C8** в сопряжении с **C1/C2**, e2e «Broadcast:
доставка кампании»); **CP-7** — «Потеря соединения» (SVC-EDGE + SVC-CORE +
SVC-CHAT/SVC-MOB, заморозка **C9** в сопряжении с **C1**, e2e «Потеря соединения»
и «Edge Cluster»); **CP-8** — «Notification в Web + Telegram» (SVC-NOTIF +
продюсеры CORE/BCAST/AI/FBP + SVC-MWS + SVC-TGC, заморозка **C10** и C7-события
`notification.created`, e2e «Notification в Web + Telegram»). M4 опирается на
результаты M3: контракты **C3/C4/C5** совместно стабилизированы на CP-4/CP-5, а
`outbox_events` и `workflow_*` готовы как стабильная база (мастер § 6, статус
CP-4/CP-5), поэтому команды продолжают работать независимо и сходятся только на
CP-6, CP-7 и CP-8.

---

# 1. Итоговая последовательность выполнения

## 1.1 Общая последовательность вех

1. **M0 — Контракты и каркас.** *(выполнено первой серией.)* Структура репозитория,
   CI-скелет, контракты v1, моки и базовые приложения/сервисы.
2. **M1 — Вертикальный срез «приём и ответ».** *(выполнено второй серией.)* Web Chat
   → Core → Manager Workspace → ответ клиенту; точка согласования **CP-1**.
3. **M2 — Омниканальность + realtime + AI Assistant.** *(выполнено третьей серией.)*
   Внешние адаптеры, WebSocket realtime, AI Assistant из Knowledge Base; **CP-2**,
   **CP-3**.
4. **M3 — Программируемость.** *(выполнено четвёртой серией.)* Форк FBP Engine, узел
   Backend API, безопасный Transform Node, визуальный редактор Workflow, AI
   Onboarding; **CP-4**, **CP-5**.
5. **M4 — Массовые коммуникации + Edge/ПДн.** *(текущий этап.)* Broadcast через
   ядро, RF Edge + VPN Tunnel + буфер/порядок/дедуп, Notification в Web и Telegram
   Console, Mobile API, сквозная идемпотентность и egress; **CP-6**, **CP-7**,
   **CP-8**.
6. **M5 — Стабилизация и приёмка.** Полный e2e-набор, нагрузка, безопасность,
   RPO/RTO, документация; **CP-9**.

Критический путь пятого этапа (§ 10.1 мастер-плана, три ветки к CP-6/CP-7/CP-8):

```text
M3 contracts C3/C4/C5 (CP-4/CP-5) + outbox_events/workflow_* заморожены
  -> SVC-DATA M4 schema (broadcast_*, notifications, notification_settings,
     edge_message_buffer в отдельной БД РФ; outbox_events уже из M3)
  -> ветка CP-6 (Broadcast): SVC-BCAST(кампании) + SVC-CORE(сквозная идемпотентность,
     egress, интеграция Broadcast) + SVC-INT(ретраи/rate limit) + SVC-API(broadcast-facade)
  -> ветка CP-7 (Edge/ПДн): SVC-EDGE(Edge+VPN+буфер+порядок) + SVC-CORE(приём C9, порядок,
     дедуп) + SVC-CHAT(РФ через Edge) + SVC-MOB(агрегация/sync/push/Edge)
  -> ветка CP-8 (Notification): SVC-NOTIF(генерация+каналы) + SVC-API(notification-facade)
     + SVC-MWS(лента уведомлений) + SVC-TGC(Telegram Console) + SVC-ADMIN(Broadcast/Notif UI)
  -> независимые работы M4: SVC-IDN(bootstrap организаций + приглашения) + SVC-FBP(version
     pinning, stateless executor)
```

## 1.2 Внутренний порядок M4

M4 лучше выполнять в три шага:

1. **M4-01, короткий обязательный предшественник.** SVC-DATA создаёт схему M4
   (§ 4.6/4.7/4.10 мастер-плана, раздел 5.5 плана SVC-DATA): `broadcasts`,
   `broadcast_recipients`, `broadcast_messages` (ссылка на `messages` — единый
   механизм доставки), `broadcast_stats`, `notifications`, `notification_settings`
   и `edge_message_buffer` (`idempotency_key`, `sequence_number`,
   `payload_encrypted`, `ttl` — **в отдельной БД РФ-контура**, RF-first), с RLS по
   `organization_id`. Таблица `outbox_events` (**C-OUT**) уже создана в **M3-01**
   как coordination-patch — здесь она **не пересоздаётся**, при необходимости лишь
   дополняются индексы/статусы. Без реальной схемы M4 integration-тесты
   BCAST/NOTIF/EDGE/CORE (кампании, уведомления, буфер, дедуп) не проходят — это
   единственный жёсткий предшественник M4.
2. **M4-02...M4-15, параллельная волна.** Владельцы сервисов реализуют
   M4-функциональность в своих зонах, потребляя схему SVC-DATA и **стабилизированные
   на CP-4/CP-5** контракты C3/C4/C5. Волна распадается на три сходящиеся ветки и
   блок независимых работ:
   - **CP-6 (Broadcast через ядро):** SVC-BCAST (запуск кампаний через единый
     механизм ядра, статистика, rate limiting, ретраи), SVC-CORE (сквозная
     идемпотентность, egress, связь `broadcast_messages ↔ messages`), SVC-INT
     (ретраи/бэкофф, rate limiting на канал, идемпотентная доставка) и SVC-API
     (фасад `broadcast-facade`, C8).
   - **CP-7 (Edge/потеря соединения):** SVC-EDGE (Edge Cluster РФ, VPN Tunnel,
     буфер, `sequence_number`, дедуп — **основная работа**), SVC-CORE (приём C9,
     восстановление порядка и дедупликация), SVC-CHAT (клиенты РФ через Edge) и
     SVC-MOB (агрегация, оффлайн-sync, push, realtime, Edge — **основная работа**).
   - **CP-8 (Notification в Web + Telegram):** SVC-NOTIF (генерация из событий
     продюсеров, категории, каналы web/telegram/email/push, настройки подписок,
     идемпотентность, NFR ≤ 1 с), SVC-API (фасад `notification-facade`, C10),
     SVC-MWS (лента/индикатор/отметка прочтения) и SVC-TGC (Telegram Console:
     уведомления, диалог, ответ клиенту + AI-подсказки).
   - **Независимые работы M4 (вне CP-6/7/8):** SVC-IDN (self-service bootstrap
     организаций и приглашения) и SVC-FBP (неизменяемость версий/version pinning
     как инварианты и stateless-масштабирование исполнителя). SVC-ADMIN участвует в
     CP-6/CP-8 частью UI (Broadcast и настройки Notification). Все бэкенд-модули
     (CORE, API, IDN) работают против реальной схемы SVC-DATA; SVC-BCAST/SVC-EDGE —
     против **моков C1/C2/C9**; фронтенды (ADMIN/MWS/TGC/CHAT/MOB) — против моков
     C8/C10/C7/C9, пока живые срезы не собраны на gate.
3. **M4-99, интеграционный gate CP-6 + CP-7 + CP-8.** Проверка, что три среза
   замыкаются сквозными сценариями: e2e «Broadcast: доставка кампании» (CP-6),
   «Потеря соединения» и «Edge Cluster» (CP-7), «Notification в Web + Telegram»
   (CP-8); заморозка **C8** (в сопряжении с C1/C2), **C9** (в сопряжении с C1) и
   **C10** (+ C7-событие `notification.created`); добавление contract-тестов
   BCAST↔CORE, EDGE↔CORE и «продюсеры↔NOTIF»; подтверждение сквозных инвариантов M4
   (сквозной `idempotency_key = message_id` на всех переходах, восстановление
   порядка по `sequence_number` в рамках Endpoint, доставка кампаний **только** через
   единый механизм ядра, RF-first размещение ПДн, RLS-изоляция арендаторов).

## 1.3 Сервисы без задач на M4

По точкам согласования мастер-плана (§ 6, § 11) M4 замыкается на **CP-6**, **CP-7**
и **CP-8**, а также включает независимые работы M4 по SVC-IDN и SVC-FBP (матрица
§ 5.1). Поэтому пятая серия ведёт работы по **четырнадцати** активным сервисам:
**SVC-DATA (01)**, **SVC-CORE (02)**, **SVC-IDN (03)**, **SVC-API (04)**,
**SVC-INT (05)**, **SVC-CHAT (06)**, **SVC-MWS (07)**, **SVC-ADMIN (08)**,
**SVC-FBP (10)**, **SVC-BCAST (11)**, **SVC-NOTIF (12)**, **SVC-EDGE (13)**,
**SVC-MOB (14)** и **SVC-TGC (15)**. Единственный сервис **без** задач на M4 —
**SVC-AI (09)**: матрица § 5.1 оставляет его столбец M4 пустым (Onboarding и
структурированные команды сделаны на M3, изоляция/мониторинг — на M5); его моки
C4 переиспользуются под регрессией. Нумерация задач сохраняет **сквозное
соответствие сервису из первой серии** (01 = SVC-DATA, 02 = SVC-CORE, 03 = SVC-IDN,
04 = SVC-API, 05 = SVC-INT, 06 = SVC-CHAT, 07 = SVC-MWS, 08 = SVC-ADMIN, 10 =
SVC-FBP, 11 = SVC-BCAST, 12 = SVC-NOTIF, 13 = SVC-EDGE, 14 = SVC-MOB, 15 =
SVC-TGC); номер **09** (SVC-AI) в этой серии не используется.

> **Замечание о разметке этапов в планах сервисов (для сопровождающих).** Вертикальный
> срез **CP-8** (генерация и доставка уведомлений в Web + Telegram) размечен в планах
> SVC-NOTIF, SVC-MWS и SVC-TGC как раздел **«M3»**, тогда как его **точка согласования
> CP-8** и поддерживающая схема (`notifications`, `notification_settings` — SVC-DATA
> § 5.5) отнесены к **M4** (мастер § 5, § 6). Четвёртая серия (M3) осознанно
> **отложила** весь объём CP-8 на M4 к его CP. Поэтому в этой серии промпты M4-07
> (SVC-MWS), M4-12 (SVC-NOTIF) и M4-15 (SVC-TGC) охватывают как «M3-размеченный» срез
> CP-8, так и собственные M4-дополнения (каналы email/push, настройки, идемпотентность,
> NFR у NOTIF; AI-подсказки у TGC). Формулировки промптов ссылаются на **оба** раздела
> соответствующих планов. Расхождение стоит устранить в мастер-плане, приведя § 5.1/§ 8.2
> в соответствие с CP-таблицей § 6 (перенос разметки CP-8 из «M3» в «M4»).

## 1.4 О `outbox_events`: наследие M3

Транзакционный outbox (`outbox_events`, **C-OUT**, мастер § 4.10) — фундамент
доставки доменных событий продюсеров (CORE/BCAST/AI/FBP) в SVC-NOTIF и SVC-FBP. По
плану SVC-DATA его создание относилось к M4 (§ 5.5), но в **M3** он понадобился
раньше — для доменных событий Workflow — и был перенесён в **M4-01→M3-01** как
coordination-patch (см. четвёртую серию, § 1.4). Поэтому на M4 таблица уже
существует и заморожена, а M4-01 её **не пересоздаёт**: SVC-DATA лишь дополняет
индексы/статусы при необходимости, а продюсеры M4 (SVC-BCAST, SVC-NOTIF)
подключаются к готовому механизму. Остальные таблицы M4 (`broadcast_*`,
`notifications`, `notification_settings`, `edge_message_buffer`) создаются в M4-01.

---

# 2. Правила для исполнителей пятой серии

- Каждый исполнитель берёт **ровно один** промпт из раздела 4.
- Формулировка задачи должна звучать как: «Выполнить этап **M4** плана
  `docs/plan/services/XX-...md`» (для CP-8-срезов — этапы **M3 и M4** плана, см.
  § 1.3).
- Реализуется **только** объём M4 своего сервиса; нельзя забегать в веху M5
  (нагрузка/деградация, отказоустойчивость Edge и RPO/RTO, полнота OpenAPI и
  версионирование API, независимое версионирование мобильного API, приёмочные
  сценарии, тонкие настройки уведомлений) сверх того, что нужно для прохождения
  CP-6, CP-7 и CP-8.
- Между CP разработка идёт против **моков** соседних контрактов: SVC-BCAST — против
  **мока C1/C2** (генерация/доставка через ядро); SVC-EDGE — против **мока C1** и
  **мока разрыва** канала; SVC-NOTIF — против **моков продюсеров** и мока Telegram;
  фронтенды (ADMIN/MWS/TGC/CHAT/MOB) — против моков C8/C10/C7/C9. Бэкенд-модули ядра
  (CORE, API, IDN) для своих integration-тестов используют **реальную схему**
  SVC-DATA (результат M4-01).
- Контрактные артефакты и их обновления кладутся в `packages/contracts`; код
  сервиса — только в его директорию из мастер-плана § 3. Схема РФ-контура
  (`edge_message_buffer`) — в отдельной БД РФ (ТЗ §7.14), миграции — исключительно у
  SVC-DATA.
- Соблюдаются сквозные инварианты: **сквозной `idempotency_key = message_id`** на
  всех переходах «клиент → Edge → буфер → Core → Adapter» (ТЗ §11.12), окно
  дедупликации; **восстановление порядка** по `sequence_number` в рамках Endpoint
  (ТЗ §7.10); доставка кампаний и уведомлений идёт **через единый механизм ядра**,
  а не в обход SVC-CORE (ТЗ §14.3); **RF-first** — первичная фиксация ПДн субъектов
  РФ в РФ-контуре (ТЗ §7.14); изоляция арендаторов по `organization_id` (RLS,
  ТЗ §22.6); авторитетная авторизация на Backend (RBAC, ТЗ §9.8).
- Для каждого промпта результатом должны быть код/миграции/документация, тесты
  (unit + integration, а на CP-6/CP-7/CP-8 — contract + e2e) и короткий отчёт: что
  сделано, какие команды проверки запущены, какие контракты затронуты.

---

# 3. Критерии готовности M4

M4 считается завершённой, когда:

- SVC-DATA создал схему M4 (`broadcasts`, `broadcast_recipients`,
  `broadcast_messages` со ссылкой на `messages`, `broadcast_stats`, `notifications`,
  `notification_settings`, `edge_message_buffer` в отдельной БД РФ с
  `idempotency_key`/`sequence_number`/`payload_encrypted`/`ttl`); миграции обратимы
  (`up`/`down`); RF-first-разделение контуров оформлено; изоляция по арендатору и
  дедупликация буфера подтверждены тестами; `outbox_events` из M3 переиспользован;
- SVC-CORE реализует сквозную идемпотентность (дедуп по `idempotency_key = message_id`
  на всех переходах, `message_delivery_attempts`), приём от SVC-EDGE (C9) с
  восстановлением порядка по `sequence_number` и дедупликацией после дренажа буфера,
  интеграцию Broadcast (доставка кампаний через единый механизм ядра, связь
  `broadcast_messages ↔ messages`);
- SVC-IDN даёт self-service bootstrap организаций (`POST /platform/organizations`,
  первый Administrator, блокировка организации) и одноразовые приглашения с TTL и
  `token_hash` (канал приглашения — telegram/email), с аудитом всех шагов;
- SVC-API предоставляет фасады `broadcast-facade` (C8: создание/запуск/статистика,
  идемпотентное создание) и `notification-facade` (C10: лента/отметка
  прочтения/настройки) с timeout + ретраями + bulkhead и деградацией без падения
  ядра;
- SVC-INT реализует ретраи с экспоненциальным бэкоффом, rate limiting на канал и
  идемпотентную доставку (повтор того же `idempotency_key` не создаёт второе внешнее
  сообщение), фиксацию попыток в `message_delivery_attempts`;
- SVC-CHAT подключает клиентов РФ через Edge Cluster: очередь неотправленных реплик
  и переотправка после разрыва без дублей, порядок в рамках Conversation/Endpoint;
- SVC-MWS отображает уведомления в web (индикатор непрочитанных, лента по категориям,
  отметка прочтения, realtime по `notification.created`) — web-часть e2e CP-8;
- SVC-ADMIN даёт раздел Broadcast (кампании, черновик, запуск, статистика/realtime по
  WS) и настройки Notification (лента, категории, каналы web/telegram/email/push);
- SVC-FBP обеспечивает неизменяемость версий (публикация новой версии, не
  перезапись), version pinning (экземпляр исполняется на зафиксированной версии) и
  stateless-исполнителя (состояние в `workflow_instance_state`, горизонтальное
  масштабирование);
- SVC-BCAST запускает кампании через единый механизм ядра (идемпотентная генерация
  `messages` с `sender_type = broadcast`, доставка через C2), собирает статистику
  (`broadcast_stats`), применяет rate limiting и ретраи без дублей, публикует
  `broadcast.state_changed` (C7);
- SVC-NOTIF генерирует уведомления из событий продюсеров по категориям, доставляет
  в Web (`notification.created`, C7) и Telegram, реализует `GET /notifications`,
  `POST /notifications/{id}:read`, `GET/PUT /notifications/settings`, добавляет
  каналы email/push, уважает подписки, дедуплицирует и держит NFR ≤ 1 с;
- SVC-EDGE даёт Edge Cluster РФ + VPN Tunnel + буфер (`edge_message_buffer`,
  `payload_encrypted`, `ttl`) с автодренажом после восстановления, присваивает
  `sequence_number` (партиционирование по `endpoint_id`) и дедуплицирует по
  `idempotency_key` совместно с SVC-CORE, без потерь/дублей/перестановок;
- SVC-MOB даёт агрегированные эндпоинты, оффлайн-синхронизацию на курсорах,
  идемпотентную отправку, push (FCM/APNs), realtime по C7 и подключение клиентов РФ
  через Edge;
- SVC-TGC доставляет уведомления менеджеру в Telegram Console, даёт просмотр
  диалога/истории (C3) и идемпотентный ответ клиенту (`POST /messages`), а также
  AI-подсказки (C4) с деградацией при недоступности AI;
- на CP-6 заморожен **C8** (в сопряжении с C1/C2) + contract BCAST↔CORE + e2e
  «Broadcast: доставка кампании»; на CP-7 заморожен **C9** (в сопряжении с C1) +
  contract EDGE↔CORE + e2e «Потеря соединения»/«Edge Cluster»; на CP-8 заморожены
  **C10** и C7-событие `notification.created` + contract «продюсеры↔NOTIF» + e2e
  «Notification в Web + Telegram»;
- CI зелёный: lint → unit → integration → contract → e2e затронутых сценариев
  (§ 9.4 мастер-плана).

---

# 4. Пятая серия промптов

## M4-01 — SVC-DATA: схема Broadcast/Notification/Edge и RF-first-контур

```text
Выполни этап M4 плана docs/plan/services/01-data-platform.md.

Цель: дать движку рассылок, уведомлениям и Edge-контуру полную схему M4 — таблицы
Broadcast, Notification и буфер Edge в отдельной БД РФ-контура (RF-first), с
изоляцией по арендатору. Транзакционный outbox уже создан в M3-01 — здесь он
переиспользуется.

Исходные документы:
- docs/plan/README.md, разделы 4.6, 4.7, 4.10, 5, 6 CP-6/CP-7/CP-8, 9, 10.1;
- docs/plan/services/01-data-platform.md, раздел 5.5 M4 (и 4.2 — группировка таблиц);
- docs/plan/services/03-communication-core.md (потребитель broadcast_*/edge_buffer),
  docs/plan/services/10-edge-websocket-gateway.md (владелец edge_message_buffer).

Зона ответственности:
- db/migrations (в т. ч. отдельная БД РФ-контура для edge_message_buffer);
- db/seeds;
- тестовые фикстуры БД в packages/testing или сервисной test-директории.

Сделай:
1. Создай broadcasts, broadcast_recipients, broadcast_messages (FK на messages —
   единый механизм доставки), broadcast_stats (prepared/sent/delivered/failed);
   RLS по organization_id.
2. Создай notifications и notification_settings (категория × канал по пользователю,
   ТЗ §15.5, §15.6); RLS по organization_id.
3. Создай edge_message_buffer в ОТДЕЛЬНОЙ БД РФ-контура (ТЗ §7.9, §7.14): колонки
   idempotency_key, sequence_number, payload_encrypted, ttl; индексы для дренажа и
   дедупликации. Оформи RF-first-разделение контуров размещения (первичная фиксация
   ПДн субъектов РФ — в РФ; зарубеж — вторичная реплика) на уровне схемы/деплоя,
   без различия структуры таблиц (мастер §4.10).
4. Переиспользуй outbox_events из M3-01 (НЕ пересоздавай таблицу); при
   необходимости дополни индекс по status/выборку pending.
5. Проверь миграции по циклу up -> down -> up на реальной БД (обе БД: основная и РФ).

Проверка:
- unit: фабрики outbox-событий и получателей рассылки, фабрики notifications;
- integration: миграции up/down; транзакционность outbox (событие и агрегат
  коммитятся/откатываются атомарно); дедупликация буфера по idempotency_key;
  изоляция broadcast_*/notifications по арендатору; связь broadcast_messages ->
  messages.

Не делай:
- не переноси бизнес-логику рассылок/уведомлений/Edge в БД — она в
  SVC-BCAST/SVC-NOTIF/SVC-EDGE/ядре;
- не пересоздавай outbox_events и workflow_* (готовы на M3);
- не добавляй партиционирование/ретеншн/процедуры обезличивания — это M5.
```

## M4-02 — SVC-CORE: сквозная идемпотентность, egress, Broadcast и приём от Edge (CP-6/CP-7)

```text
Выполни этап M4 плана docs/plan/services/03-communication-core.md.

Цель: единый механизм доставки, устойчивый к ретраям и разрывам — сквозная
идемпотентность, интеграция Broadcast через ядро (CP-6) и приём от SVC-EDGE с
восстановлением порядка и дедупликацией (CP-7). SVC-CORE — участник CP-6 и CP-7.

Исходные документы:
- docs/plan/README.md, разделы 4.4, 4.10, 7.1, 8.2, 6 CP-6/CP-7, 10 (риск порядка);
- docs/plan/services/03-communication-core.md, раздел M4 и CP-6/CP-7.

Зона ответственности:
- services/backend/src/modules/communication-core;
- потребление broadcast_messages/messages/edge-приёма (результат M4-01) через backend;
- фасады к SVC-BCAST и SVC-EDGE через моки; tests/contract.

Сделай:
1. Сквозная идемпотентность (ТЗ §11.12): дедупликация по idempotency_key = message_id
   на всех переходах (клиент -> Edge -> буфер -> Core -> Adapter), окно дедупликации,
   полные message_delivery_attempts (ТЗ §10.8, §14.9).
2. Интеграция с SVC-BCAST (CP-6): доставка кампаний ЧЕРЕЗ единый механизм ядра
   (C1/C2), связь broadcast_messages <-> messages; кампании не идут в обход ядра.
3. Приём от SVC-EDGE (C9, CP-7): восстановление порядка по sequence_number
   (ключ партиционирования — endpoint_id) и дедупликация после восстановления
   соединения/дренажа буфера (ТЗ §7.9-§7.10).

Проверка:
- unit: дедупликация при ретраях/дублировании, восстановление порядка после разрыва;
- integration: Backend<->PostgreSQL (дедуп, порядок из буфера), contract EDGE<->CORE
  и BCAST<->CORE через моки;
- e2e: «Broadcast: доставка кампании» (CP-6), «Потеря соединения» (буфер/порядок/дедуп,
  CP-7).

Не делай:
- транспорт Edge/VPN и буферизацию держит SVC-EDGE; ядро — приёмник C9;
- генерацию кампаний/статистику держит SVC-BCAST; ядро только доставляет через C1/C2;
- нагрузку/деградацию адаптеров и масштабирование экземпляров — это M5.
```

## M4-03 — SVC-IDN: self-service bootstrap организаций и приглашения

```text
Выполни этап M4 плана docs/plan/services/02-identity-platform.md.

Цель: заменить seeded-bootstrap M1 на полноценный self-service провижининг
организаций и поток одноразовых приглашений (ТЗ §9.10). Работа M4 не завязана на
CP-6/7/8 — идёт независимо.

Исходные документы:
- docs/plan/README.md, разделы 4.1/4.2, 5.1 (строка SVC-IDN), 9.10, 22.6, 23.8;
- docs/plan/services/02-identity-platform.md, раздел M4.

Зона ответственности:
- services/backend/src/modules/identity;
- доменный сервис провижининга через SVC-API; запись в audit_events, invitations.

Сделай:
1. POST /platform/organizations — провижининг Tenant (изолированная область данных,
   §22.6) через доменный сервис Backend.
2. POST /platform/organizations/{id}/administrators — создание первого Administrator;
   invitations с token_hash, TTL, одноразовость.
3. POST /invitations и приём приглашения: первый вход по приглашению (личность
   устанавливается по токену, а не по «существованию пользователя», ТЗ §9.10, шаг 3);
   contact_type допускает telegram/email (канал не завязан на единственный мессенджер,
   ТЗ §9.6).
4. POST /platform/organizations/{id}/block — блокировка организации.
5. Все шаги пишут аудит (ТЗ §9.10, §23.8).

Проверка:
- unit: генерация/проверка/истечение/одноразовость токена приглашения;
- integration: Backend<->PostgreSQL — bootstrap создаёт Tenant + первого admin,
  приглашение активируется однократно; изоляция (приглашение видно только своей
  организации);
- e2e: «Авторизация» дополняется первичной активацией через приглашение.

Не делай:
- не реализуй резервный вход/расширяемость методов входа — это M5;
- проверки прав не дублируй в UI как авторитетные — RBAC на Backend (ТЗ §9.8).
```

## M4-04 — SVC-API: фасады broadcast-facade (C8) и notification-facade (C10) (CP-6/CP-8)

```text
Выполни этап M4 плана docs/plan/services/04-backend-api.md.

Цель: тонкие фасады broadcast-facade (C8) и notification-facade (C10) с
устойчивостью и деградацией без падения ядра. SVC-API — участник CP-6 и CP-8.

Исходные документы:
- docs/plan/README.md, разделы 7.2, 8.2, 9, 6 CP-6/CP-8, 11.2;
- docs/plan/services/04-backend-api.md, раздел M4.

Зона ответственности:
- services/backend/src/modules/{broadcast-facade,notification-facade};
- packages/contracts/openapi/backend-core (C8/C10 поверх C3);
- фасады к SVC-BCAST и SVC-NOTIF через моки контрактов.

Сделай:
1. Фасад broadcast-facade (C8): POST /broadcasts, POST /broadcasts/{id}:start,
   GET /broadcasts/{id}/stats — контрактный вызов SVC-BCAST; идемпотентное создание
   (ТЗ §11.12).
2. Фасад notification-facade (C10): GET /notifications, POST /notifications/{id}:read,
   GET/PUT /notifications/settings — контрактный вызов SVC-NOTIF.
3. Устойчивость: timeout + очередь с ретраями + bulkhead; деградация без падения ядра
   (ТЗ §11.2, §11.11).

Проверка:
- unit: валидаторы DTO broadcast/notification, идемпотентность создания, логика
  деградации;
- integration: Backend<->BCAST и Backend<->NOTIF через моки контрактов; эндпоинты
  покрыты 3 случаями;
- e2e: участие в «Broadcast: доставка кампании» (CP-6) и «Notification в Web +
  Telegram» (CP-8).

Не делай:
- логику кампаний/статистики держит SVC-BCAST, генерацию уведомлений — SVC-NOTIF;
- не реализуй полноту OpenAPI и контроль версии API — это M5.
```

## M4-05 — SVC-INT: ретраи, rate limiting, идемпотентная доставка (CP-6)

```text
Выполни этап M4 плана docs/plan/services/05-integration-platform.md.

Цель: надёжная массовая доставка через адаптеры (CP-6) — ретраи с бэкоффом,
rate limiting на канал и идемпотентность без дублей. SVC-INT — участник CP-6.

Исходные документы:
- docs/plan/README.md, разделы 4.5, 7.1, 8.2, 6 CP-6, 10.8/10.9/11.12;
- docs/plan/services/05-integration-platform.md, раздел 5.5 M4.

Зона ответственности:
- services/integration-platform;
- запись message_delivery_attempts через Backend; фасад к внешним API через моки.

Сделай:
1. Ретраи и обработка ошибок доставки (ТЗ §10.8): регистрация ошибки, оценка
   повторяемости, повтор с экспоненциальным бэкоффом, уведомление ядра; фиксация
   попыток в message_delivery_attempts.
2. Rate limiting на канал (ТЗ §10.9): лимиты внешних API, изоляция нагрузки между
   каналами, backpressure при исчерпании.
3. Идемпотентная доставка: сквозной idempotency_key (= message_id) идёт до внешнего
   канала; повтор с обработанным ключом отбрасывается (ТЗ §11.12; совместимость
   at-least-once ретраев и отсутствия дублей).

Проверка:
- unit: логика ретраев/бэкоффа (расписание, предел, классификация повторяемых/
  неповторяемых ошибок), маппинг лимитов канала;
- integration: Backend<->Integration через мок внешнего API — ретрай без дублей
  (повтор того же idempotency_key не создаёт второе внешнее сообщение), rate limit,
  запись message_delivery_attempts;
- e2e: CP-6 «Broadcast: доставка кампании» с ретраями/лимитами.

Не делай:
- не реализуй деградацию всех каналов и отказоустойчивость при недоступности API —
  это M5;
- генерацию кампаний держит SVC-BCAST; SVC-INT доставляет во внешние каналы.
```

## M4-06 — SVC-CHAT: подключение клиентов РФ через Edge Cluster (CP-7)

```text
Выполни этап M4 плана docs/plan/services/13-web-chat.md (раздел 5.5 M4).

Цель: виджет работает для клиентов РФ через Edge Cluster — буферизация/переотправка
при разрыве, идемпотентность и порядок (CP-7, совместно с SVC-EDGE/CORE).

Исходные документы:
- docs/plan/README.md, разделы 6 CP-7, 8.2, 7.6/7.9/7.10/11.12, 18.7;
- docs/plan/services/13-web-chat.md, раздел 5.5 M4 и CP-7.

Зона ответственности:
- apps/web-chat (виджет);
- потребление C9/WS через Edge — реальные или моки; эмуляция разрыва.

Сделай:
1. Подключение через Edge: соединение виджета (REST/WS) проходит через Edge
   ПРОЗРАЧНО (ТЗ §18.7, §7.6, §5.2).
2. Устойчивость при разрыве: очередь неотправленных реплик на стороне виджета и
   переотправка после восстановления; дедупликация по сквозному idempotency_key
   (= message_id, ТЗ §11.12).
3. Порядок в рамках Conversation/Endpoint (ТЗ §7.10); лента без пропусков после
   переподключения.

Проверка:
- unit: поведение при разрыве (очередь, переотправка), отсутствие дублей при повторе
  того же idempotency_key, сохранение порядка;
- integration: против мок-Backend/WS с эмуляцией разрыва — переотправка без дублей,
  корректный порядок;
- e2e (Playwright): CP-7 «Потеря соединения» — буфер/восстановление без потерь/дублей,
  порядок (совместно с SVC-EDGE/CORE).

Не делай:
- серверный буфер Edge и C9 держит SVC-EDGE (владелец контракта) — виджет лишь
  потребляет;
- accessibility и приёмку виджета — это M5.
```

## M4-07 — SVC-MWS: лента уведомлений в web (CP-8)

```text
Выполни этап M3 плана docs/plan/services/12-manager-workspace.md («Интерфейс
уведомлений (CP-8)»). Примечание: срез CP-8 размечен в плане как M3, но его точка
согласования и схема отнесены к вехе M4 — поэтому он выполняется в этой (M4) серии.
Крупных отдельных M4-задач у SVC-MWS нет (§ 5.1).

Цель: отображение внутренних уведомлений менеджера в web на C10 — web-часть e2e
«Notification в Web + Telegram». SVC-MWS — участник CP-8.

Исходные документы:
- docs/plan/README.md, разделы 6 CP-8, 8.2, 11.7, 15.5/15.6;
- docs/plan/services/12-manager-workspace.md, раздел M3 (CP-8) и M4.

Зона ответственности:
- apps/manager-workspace;
- потребление C10 и C7-события notification.created — реальные или MSW-моки.

Сделай:
1. Индикатор уведомлений — счётчик непрочитанных; realtime через notification.created
   (ТЗ §11.7).
2. Список уведомлений — GET /notifications с категориями (info/warning/error/
   critical/admin, ТЗ §15.5).
3. Отметка прочтения — POST /notifications/{id}:read (ТЗ §15.6); синхронизация
   счётчика.

Проверка:
- unit: индикатор/список/отметка прочтения; обработка notification.created;
- integration: против мок-C10/WS (MSW);
- e2e (Playwright): «Notification в Web» (web-часть сценария «Notification в Web +
  Telegram», CP-8).

Не делай:
- доставку в Telegram держит SVC-TGC; генерацию уведомлений — SVC-NOTIF;
- приёмку/производительность/полировку — это M5.
```

## M4-08 — SVC-ADMIN: Broadcast и настройки Notification (CP-6/CP-8)

```text
Выполни этап M4 плана docs/plan/services/11-saas-administration.md.

Цель: администратор управляет массовыми коммуникациями (Broadcast, C8) и
уведомлениями (Notification, C10). SVC-ADMIN — участник CP-6 (Broadcast UI) и
CP-8 (настройки Notification).

Исходные документы:
- docs/plan/README.md, разделы 6 CP-6/CP-8, 8.2, 15.4;
- docs/plan/services/11-saas-administration.md, раздел M4.

Зона ответственности:
- apps/saas-admin;
- потребление C8 (Broadcast) и C10 (Notification) — реальные или MSW-моки;
- Playwright-сценарии кампаний и настроек уведомлений.

Сделай:
1. Раздел Broadcast (C8): список кампаний, черновик (шаблон, фильтр получателей,
   расписание, ограничение скорости), запуск, статистика и realtime-статус по WS
   (broadcast.state_changed, C7).
2. Настройки Notification (C10): лента уведомлений, отметка «прочитано», управление
   категориями и каналами доставки (web/telegram/email/push, ТЗ §15.4).

Проверка:
- unit: форма кампании, таблица статистики, форма настроек уведомлений;
- integration (MSW): создание и запуск кампании, изменение настроек уведомлений;
- e2e (Playwright): участие в «Broadcast: доставка кампании» (CP-6) и «Notification
  в Web + Telegram» (CP-8) на UI-стороне.

Не делай:
- логику доставки кампаний/уведомлений держат SVC-BCAST/SVC-NOTIF/ядро; UI лишь
  вызывает фасады C8/C10;
- приёмочные сценарии/доступность/адаптивность — это M5.
```

## M4-10 — SVC-FBP: неизменяемые версии, version pinning, stateless-масштабирование

```text
Выполни этап M4 плана docs/plan/services/07-fbp-engine.md.

Цель: закрепить неизменяемость версий, корректный version pinning и горизонтальное
масштабирование исполнителя. Работа M4 не завязана на CP-6/7/8 — идёт независимо.

Исходные документы:
- docs/plan/README.md, разделы 4.8, 5.1 (строка SVC-FBP), 13.10, 25.3;
- docs/plan/services/07-fbp-engine.md, раздел M4.

Зона ответственности:
- services/fbp-engine;
- потребление workflow_* и workflow_instance_state (готовы на M3-01) через Backend.

Сделай:
1. Неизменяемые версии схем: изменение порождает НОВУЮ версию, а не перезапись
   (ТЗ §13.10); отклонение попытки перезаписать существующую версию.
2. Version pinning: запущенный экземпляр исполняется до завершения на зафиксированной
   версии; публикация новой версии влияет только на последующие запуски (ТЗ §13.10).
   Переключение «версии по умолчанию» — конфигурацией.
3. Stateless executor (ТЗ §25.3): вынос состояния экземпляра в workflow_instance_state
   (через Backend); исполнитель без памяти между шагами; горизонтальное
   масштабирование — любой узел-исполнитель обрабатывает любой экземпляр.

Проверка:
- unit: привязка версии к экземпляру, отклонение перезаписи версии, восстановление
  шага из внешнего состояния;
- integration: восстановление stateless-исполнителя из состояния (другой узел
  продолжает экземпляр по workflow_instance_state); совместимость pinning с
  масштабированием;
- e2e: старые экземпляры завершаются на своей версии при публикации новой.

Не делай:
- не меняй нейтральный набор узлов, узел Backend API и Transform Node — сделаны на M3;
- инициатор Workflow всегда Backend (ТЗ §6.13);
- нагрузочное масштабирование под приёмку — это M5.
```

## M4-11 — SVC-BCAST: запуск кампаний через единый механизм ядра (CP-6)

```text
Выполни этап M4 плана docs/plan/services/08-broadcast-platform.md.

Цель: кампания доставлена ЧЕРЕЗ ядро (сообщения созданы в messages, доставка через
C2/адаптеры), собрана статистика — точка согласования CP-6. SVC-BCAST — участник
CP-6.

Исходные документы:
- docs/plan/README.md, разделы 4.6, 7.1, 8.2, 6 CP-6, 14.3/14.6/14.8/14.9, 11.12;
- docs/plan/services/08-broadcast-platform.md, раздел M4 и CP-6.

Зона ответственности:
- services/broadcast-platform;
- packages/contracts для C8; contract/integration BCAST<->CORE через мок C1/C2.

Сделай:
1. Запуск кампании (:start): ИДЕМПОТЕНТНАЯ генерация сообщений в ядре (C1,
   sender_type = broadcast, idempotency_key = message_id, ТЗ §11.12) и доставка
   ЧЕРЕЗ единый механизм ядра/адаптеров (C2), связь broadcast_messages <-> messages.
2. Rate limiting (ТЗ §14.6): батчинг и лимитер на канал/организацию с учётом
   Capability (C6).
3. Ретраи и обработка ошибок (ТЗ §14.9): повтор при временных ошибках, согласованный
   со сквозной идемпотентностью (без дублей, ТЗ §11.12).
4. Сбор статистики (broadcast_stats: prepared/sent/delivered/failed) из статусов
   ядра; событие broadcast.state_changed (C7).

Проверка:
- unit: логика rate limiting/бэкоффа (не превышает лимиты), подсчёт статистики
  (в т. ч. при частичных сбоях), формирование сообщения из шаблона;
- integration: генерация сообщений в ядре через мок (C1/C2), идемпотентность
  повторного запуска (без дублей), contract BCAST<->CORE;
- e2e: «Broadcast: доставка кампании» (CP-6).

Не делай:
- не обходи SVC-CORE — доставка только через единый механизм ядра (ТЗ §14.3);
- нагрузку на крупные кампании и устойчивость к отказам адаптеров — это M5.
```

## M4-12 — SVC-NOTIF: генерация и доставка уведомлений, каналы, настройки, NFR (CP-8)

```text
Выполни этапы M3 и M4 плана docs/plan/services/09-notification-platform.md.
Примечание: вертикальный срез CP-8 (генерация + доставка в Web и Telegram) размечен
в плане как M3, но его точка согласования CP-8 и схема отнесены к вехе M4 — поэтому
он выполняется в этой (M4) серии вместе с M4-дополнениями (каналы email/push,
настройки, идемпотентность, NFR). SVC-NOTIF — центральный участник CP-8.

Исходные документы:
- docs/plan/README.md, разделы 4.7, 4.10, 7.1, 7.3, 8.2, 6 CP-8, 15.2/15.4/15.5/15.6,
  25.2;
- docs/plan/services/09-notification-platform.md, разделы M3, M4 и CP-8.

Зона ответственности:
- services/notification-platform;
- packages/contracts для C10 и C7-события notification.created;
- потребление событий продюсеров через outbox_events/внутренний контракт; моки
  продюсеров и Telegram.

Сделай:
1. Приём событий продюсеров (CORE/BCAST/AI/FBP) через outbox_events/внутренний
   контракт (ТЗ §15.2); формирование уведомлений по категориям (ТЗ §15.5) — маппинг
   «событие -> категория/адресат», запись notifications.
2. Доставка в web — публикация WS-события notification.created (C7, ТЗ §11.7);
   доставка в Telegram Console через SVC-INT/SVC-TGC (ТЗ §20.3).
3. Эндпоинты: GET /notifications, POST /notifications/{id}:read, GET/PUT
   /notifications/settings (базовые подписки web/telegram).
4. Дополнительные каналы (ТЗ §15.4): email и push через внешних провайдеров;
   уважение подписок — доставка только по включённым (категория × канал) для
   пользователя (ТЗ §15.6).
5. Идемпотентность/дедупликация: один ключ логического события не порождает дубль
   уведомления; NFR «Получение уведомлений <= 1 с» (ТЗ §25.2) для GET /notifications
   (индексы, постраничная выдача).

Проверка:
- unit: маршрутизация по категориям/каналам, формирование записи notifications,
  применение настроек (отключённая подписка -> нет доставки), дедупликация;
- integration: Backend<->Notification (приём события, запись), доставка в WS (C7) и
  Telegram (мок), email/push (моки провайдеров), изоляция арендатора, бюджет <= 1 с;
- contract: «продюсеры<->NOTIF» и NOTIF<->MWS/TGC;
- e2e: «Notification в Web + Telegram» (CP-8), в т. ч. при разных настройках подписок.

Не делай:
- тонкие настройки, приоритеты critical/admin и устойчивость при отказе канала —
  это M5;
- отображение в web/telegram держат SVC-MWS/SVC-TGC; NOTIF генерирует и доставляет.
```

## M4-13 — SVC-EDGE: Edge Cluster РФ, VPN Tunnel, буфер, порядок, дедуп (CP-7, ОСНОВНАЯ работа)

```text
Выполни этап M4 плана docs/plan/services/10-edge-websocket-gateway.md.

Цель: замкнуть сквозной сценарий — трафик РФ через Edge + VPN Tunnel с буферизацией
при разрыве, восстановлением порядка и дедупликацией, при соблюдении RF-first. Это
ОСНОВНАЯ работа M4; SVC-EDGE — участник CP-7.

Исходные документы:
- docs/plan/README.md, разделы 4.10, 6 CP-7, 8.2, 7.3/7.6/7.8/7.9/7.10/7.14, 11.12;
- docs/plan/services/10-edge-websocket-gateway.md, раздел M4 и CP-7.

Зона ответственности:
- services/edge-gateway (+ VPN Tunnel Service);
- запись/дренаж edge_message_buffer (БД РФ-контура, результат M4-01);
- packages/contracts для C9; contract/integration EDGE<->CORE через мок C1.

Сделай:
1. Edge Cluster в РФ (ТЗ §7.3, §7.6): региональная точка входа, первичная фиксация
   ПДн субъектов РФ в РФ-контуре (RF-first, ТЗ §7.14).
2. VPN Tunnel Service (ТЗ §7.8): защищённый канал Edge<->App (взаимная
   аутентификация, шифрование, контроль соединения, авто-восстановление,
   backpressure).
3. Буферизация при разрыве (ТЗ §7.9): при недоступности канала приём продолжается,
   сообщения складываются в edge_message_buffer (payload_encrypted, ttl); после
   восстановления — автоматический дренаж в Communication Core (C9), без потерь.
4. Восстановление порядка (ТЗ §7.10): присвоение sequence_number на входе Edge
   (ключ партиционирования — endpoint_id), передача через туннель.
5. Дедупликация по сквозному idempotency_key (ТЗ §11.12) совместно с SVC-CORE:
   повторно переданные из буфера сообщения отбрасываются на приёмнике.
6. Интеграция с SVC-CHAT/SVC-MOB — их клиентские подключения РФ идут через Edge.

Проверка:
- unit: присвоение/проверка sequence_number, дедупликация по idempotency_key, логика
  буфера (запись/ttl/дренаж), шифрование payload;
- integration: Backend<->WebSocket, пересылка через туннель с восстановлением порядка
  на моке разрыва канала;
- contract: EDGE<->CORE (C9 в сопряжении с C1);
- e2e: «Edge Cluster» (РФ->VPN Tunnel->обработка) и «Потеря соединения»
  (буфер->восстановление->без потерь/дублей, порядок) — CP-7.

Не делай:
- отказоустойчивость Edge, RPO/RTO буфера и нагрузку на WS — это M5;
- восстановление порядка/дедуп на приёмнике — совместная зона с SVC-CORE (C9),
  не переписывай ядро.
```

## M4-14 — SVC-MOB: агрегация, оффлайн-sync, push, realtime, Edge (CP-7, ОСНОВНАЯ работа)

```text
Выполни этап M4 плана docs/plan/services/15-mobile-api.md.

Цель: работающий мобильный BFF — агрегированные экраны, устойчивая
оффлайн-синхронизация, push и realtime; клиенты РФ работают через Edge. Это ОСНОВНАЯ
работа M4; SVC-MOB — участник CP-7.

Исходные документы:
- docs/plan/README.md, разделы 6 CP-7, 7.3, 8.2, 19.2-19.5, 11.12, 15.4, 25.2;
- docs/plan/services/15-mobile-api.md, раздел M4 и CP-7.

Зона ответственности:
- services/mobile-api (BFF);
- потребление C3/C10/C7/C9 через моки; моки FCM/APNs и WS.

Сделай:
1. Агрегированные эндпоинты — «экранные» ответы (диалоги с превью/счётчиками,
   история, уведомления) из C3.conversations/messages/clients/C10 (ТЗ §19.2-§19.3).
2. Оффлайн-синхронизация — GET /mobile/v1/sync на дельтах/курсорах: изменения после
   курсора + новый курсор; «оффлайн -> онлайн» без потерь/дублей (ТЗ §19.3).
3. Идемпотентная отправка — POST /mobile/v1/messages со сквозным idempotency_key =
   message_id (ТЗ §11.12), проксирование в C3.messages.
4. Push — регистрация устройства/токена (POST /mobile/v1/devices), ретрансляция
   C10 -> FCM/APNs, fallback «нет WS -> push + sync» (ТЗ §19.4, §15.4).
5. Realtime через WS — потребление C7-событий (message.created,
   message.status_changed, notification.created, typing.*).
6. Подключение клиентов РФ через Edge (C9/SVC-EDGE, ТЗ §19.5, §7.6); консистентность
   при разрыве даёт Edge-буфер/порядок/дедуп, SVC-MOB её потребляет.

Проверка:
- unit: агрегаторы (композиция C3.* -> экранный DTO), логика дельта-синхронизации/
  курсоров (монотонность, нет потерь/дублей), маппинг push (C10 -> FCM/APNs),
  идемпотентный ключ отправки;
- integration: против мок-Backend/мок-WS — оффлайн->онлайн синхронизация, доставка
  push через мок-провайдер, проксирование POST /messages с дедупликацией; бюджеты
  (диалоги <= 1 с, история <= 2 с, уведомления <= 1 с, ТЗ §25.2);
- e2e: «Потеря соединения» (мобильная часть) и мобильный realtime (CP-7): клиент РФ
  через Edge, разрыв -> восстановление -> синхронизация без потерь/дублей и порядка.

Не делай:
- независимое версионирование §19.6, нагрузочные пробники и приёмку — это M5;
- буфер/порядок Edge держит SVC-EDGE; SVC-MOB потребляет консистентность.
```

## M4-15 — SVC-TGC: Telegram Console — уведомления, ответ клиенту, AI-подсказки (CP-8)

```text
Выполни этапы M3 и M4 плана docs/plan/services/14-telegram-console.md.
Примечание: вертикальный срез CP-8 (уведомления в Telegram, просмотр диалога и ответ
клиенту) размечен в плане как M3, но его точка согласования CP-8 и схема отнесены к
вехе M4 — поэтому он выполняется в этой (M4) серии вместе с M4-дополнениями
(AI-подсказки, быстрые ответы). SVC-TGC — telegram-часть CP-8.

Исходные документы:
- docs/plan/README.md, разделы 6 CP-8, 8.2, 20.2-20.6, 15.4, 11.12, 12.3;
- docs/plan/services/14-telegram-console.md, разделы M3 (CP-8) и M4.

Зона ответственности:
- services/telegram-console (бот);
- потребление C10 (telegram-канал), C3 (диалоги/сообщения), C4 (AI) через моки.

Сделай:
1. Привязка Telegram-аккаунта менеджера к пользователю платформы поверх
   Telegram-входа (ТЗ §9.5) и серверная сессия для вызовов Backend.
2. Доставка уведомлений в Telegram — приём канала telegram от SVC-NOTIF (C10,
   ТЗ §15.4, §20.3), рендеринг карточек с inline-кнопками.
3. Просмотр активных диалогов и истории через C3.conversations
   (GET /conversations, .../{id}, .../{id}/messages); краткая сводка по клиенту.
4. Ответ клиенту через Backend — POST /messages (C3.messages, идемпотентно,
   ТЗ §20.4, §11.12); доставка до клиента — SVC-CORE + Adapter.
5. Inline-кнопки быстрых действий: «Открыть диалог», «Ответить», «Открыть в Manager
   Workspace» (ссылка, ТЗ §20.2).
6. AI-подсказки (C4 через POST /ai/assistant:suggest, ТЗ §20.6, §12.3): резюме,
   рекомендуемый ответ, поиск по KB, перевод — применяются ВРУЧНУЮ менеджером;
   быстрые ответы/шаблоны; деградация AI без блокировки уведомлений/ответов
   (ТЗ §5.4, §12.1).

Проверка:
- unit: обработчики команд/кнопок (роутинг callback -> действие), привязка аккаунта,
  формирование ответа (POST /messages с idempotency_key), рендер карточки, сборка
  запроса assistant:suggest, поведение при недоступном AI (graceful);
- integration: против мок-Backend/мок-Telegram/мок-AI — доставка уведомления
  (C10 telegram -> сообщение), отправка ответа (кнопка «Ответить» -> POST /messages,
  идемпотентность), просмотр диалога, получение подсказки и вставка в ответ;
- e2e: «Notification в Web + Telegram» (telegram-часть, CP-8) — уведомление доставлено
  менеджеру в бот и отображено; запрос AI-подсказки и ответ клиенту.

Не делай:
- ограничения Telegram Bot API (rate limits) и приёмку — это M5;
- данные — только через Backend; проверки прав — на Backend (ТЗ §9.8).
```

## M4-99 — Интеграционный gate M4 (CP-6 + CP-7 + CP-8)

```text
Выполни интеграционный gate CP-6, CP-7 и CP-8 для завершения M4 после выполнения
M4-01...M4-15.

Цель: убедиться, что срезы массовых коммуникаций, Edge/ПДн и уведомлений замыкаются
сквозными сценариями, и заморозить C8 (в сопряжении с C1/C2), C9 (в сопряжении с C1)
и C10 (+ C7-событие notification.created).

Исходные документы:
- docs/plan/README.md, разделы 5, 6 CP-6/CP-7/CP-8, 7, 8.2, 9, 10;
- docs/plan/services/{01,03,04,05,08,09,10,11,12,13,14,15}-*.md, разделы M4 (и M3 для
  CP-8: 09/12/14).

Зона ответственности:
- tests/e2e для сценариев M4;
- tests/contract для BCAST<->CORE, EDGE<->CORE и «продюсеры<->NOTIF»;
- packages/contracts (заморозка C8 на CP-6; C9 на CP-7; C10 и notification.created
  на CP-8);
- CI jobs; docs/plan status notes, если нужно.

Сделай:
1. Собери и прогони e2e «Broadcast: доставка кампании» (CP-6) на связке
   SVC-BCAST + SVC-CORE + SVC-INT + SVC-API.
2. Собери и прогони e2e «Потеря соединения» и «Edge Cluster» (CP-7) на связке
   SVC-EDGE + SVC-CORE + SVC-CHAT/SVC-MOB.
3. Собери и прогони e2e «Notification в Web + Telegram» (CP-8) на связке
   SVC-NOTIF + продюсеры + SVC-MWS + SVC-TGC + SVC-API.
4. Добавь и проверь contract-тесты BCAST<->CORE, EDGE<->CORE и «продюсеры<->NOTIF»
   (+ NOTIF<->MWS/TGC).
5. Проверь сквозные инварианты M4: сквозной idempotency_key = message_id на всех
   переходах (нет дублей); восстановление порядка по sequence_number в рамках
   Endpoint; доставка кампаний и уведомлений только через единый механизм ядра;
   RF-first размещение ПДн (буфер Edge в БД РФ); RLS-изоляция арендаторов.
6. Зафиксируй заморозку C8 на CP-6, C9 на CP-7, C10 (+ notification.created) на CP-8;
   отметь в планах сервисов завершение этапа M4.
7. Сформируй список готовности к M5: что стабильно (C8/C9/C10, broadcast_*, edge_buffer,
   notifications) и что входит в M5 (нагрузка/деградация, отказоустойчивость Edge и
   RPO/RTO, полнота OpenAPI/версионирование, тонкие настройки уведомлений, приёмка
   CP-9).

Проверка:
- workspace lint/test/build;
- integration + contract + e2e затронутых сценариев (§ 9.4);
- если есть docker-compose стенд, подними связку M4 (в т. ч. БД РФ-контура) и прогони
  три среза end-to-end.

Не делай:
- не переписывай чужие сервисные реализации крупными правками; при конфликте
  контрактов/ownership зафиксируй его как blocker и предложи минимальный patch;
- не забегай в M5 (нагрузка, отказоустойчивость, приёмка, версионирование) сверх
  фиксации границ.
```

---

# 5. Что запускать первым

Минимальный практичный запуск M4:

1. Выполнить **M4-01** (SVC-DATA) — обязательный предшественник: без реальной схемы
   M4 (`broadcast_*`, `notifications`, `notification_settings`, `edge_message_buffer`
   в БД РФ; `outbox_events` уже из M3) integration-тесты BCAST/NOTIF/EDGE/CORE не
   проходят.
2. Как только схема готова, параллельно запустить три сходящиеся ветки и блок
   независимых работ:
   - **CP-6 (Broadcast через ядро):** **M4-11** (BCAST: кампании + статистика),
     **M4-02** (CORE: сквозная идемпотентность + egress + интеграция Broadcast),
     **M4-05** (INT: ретраи/rate limit/идемпотентность) и **M4-04** (API:
     broadcast-facade).
   - **CP-7 (Edge/потеря соединения):** **M4-13** (EDGE: Edge+VPN+буфер+порядок),
     **M4-02** (CORE: приём C9, порядок, дедуп), **M4-06** (CHAT: РФ через Edge) и
     **M4-14** (MOB: агрегация/sync/push/Edge).
   - **CP-8 (Notification в Web + Telegram):** **M4-12** (NOTIF: генерация + каналы),
     **M4-04** (API: notification-facade), **M4-07** (MWS: лента уведомлений),
     **M4-15** (TGC: Telegram Console) и **M4-08** (ADMIN: Broadcast/Notif UI).
   - **Независимые работы M4:** **M4-03** (IDN: bootstrap организаций + приглашения)
     и **M4-10** (FBP: version pinning + stateless executor). Бэкенд-модули
     (CORE/API/IDN) идут против реальной схемы SVC-DATA; SVC-BCAST/SVC-EDGE — против
     моков C1/C2/C9; фронтенды — против моков C8/C10/C7/C9 до сборки живых срезов.
3. Единственный сервис без задач на M4 — **SVC-AI (09)**: в этой серии не
   запускается, его моки C4 сохраняются под регрессией.
4. После слияния результатов выполнить **M4-99** (gate CP-6 + CP-7 + CP-8) и только
   затем открывать серию M5-промптов для приёмки (CP-9).
