# M5 Acceptance Gate (CP-9): приёмка и финальная заморозка v1

Дата приёмки: 2026-07-04. Веха **M5**, точка согласования **CP-9** (мастер-план
§5, §6). Документ сводит результаты интеграционного gate M5-99: полный e2e-набор
§26.6 зелёный, нагрузка/деградация проверены, security review §23 пройден,
RPO/RTO подтверждены, документация §28 завершена, критерии приёмки §29 выполнены,
все контракты v1 финально заморожены.

Машинно-читаемый артефакт заморозки: `packages/contracts/cp9-freeze.v1.json`
(все контракты как `released_v1`), скреплён gate-тестом
`tests/contract/m5-gate-freeze.test.mjs`.

## 1. Полный e2e-набор §26.6 (регрессия)

`npm run test:e2e` — все 11 обязательных сценариев зелёные:

| Сценарий §26.6 | Ведущий e2e |
|---|---|
| Авторизация | `apps/saas-admin/test/e2e/saas-admin.auth.spec.ts` |
| Работа менеджера | `apps/manager-workspace/test/e2e/manager-workspace.m1.spec.ts` |
| Web Chat | `tests/e2e/web-chat-cp1.test.mjs` |
| Telegram | `tests/e2e/telegram-cp2.test.mjs` |
| AI Assistant из KB | `tests/e2e/ai-assistant-kb.test.mjs` |
| Workflow вызывает Backend API | `tests/e2e/workflow-cp4.test.mjs`, `tests/e2e/workflow-fbp-m5-cp9.test.mjs` |
| AI Onboarding применяет конфиг | `tests/e2e/ai-onboarding-apply.test.mjs` |
| Notification в Web + Telegram | `tests/e2e/notification-delivery-cp9.test.mjs`, `tests/e2e/telegram-console-cp8.test.mjs` |
| Broadcast: доставка кампании | `tests/e2e/broadcast-delivery-cp6.test.mjs` |
| Edge Cluster | `tests/e2e/edge-cluster-cp7.test.mjs` |
| Потеря соединения | `tests/e2e/edge-connection-loss-cp7.test.mjs`, `tests/e2e/edge-resilience-cp9.test.mjs`, `tests/e2e/mobile-connection-loss-cp7.test.mjs` |

Дополнительно на приёмке зелёные: `tests/e2e/communication-core-cp9.test.mjs`,
`tests/e2e/integration-degradation-cp9.test.mjs`.

## 2. Нагрузочные пробники и деградация (§25.2/§25.3/§25.11)

- Ядро: `docs/operations/communication-core-m5-load-probes.md` — приём/маршрутизация
  под параллелизмом, деградация адаптеров и AI, multi-instance idempotency.
- API (p95, без времени внешних LLM): `services/backend/test/integration/m5-nfr.spec.ts`
  — `conversation_list` ≤ 1000 ms, `message_history` ≤ 2000 ms, `send_message`
  ≤ 1000 ms, `ai_assistant_without_llm` ≤ 500 ms.
- MOB: `docs/operations/mobile-api-m5-acceptance.md` — агрегированные BFF-вызовы в
  бюджете §25.2.
- FBP: `experiments/m5-fbp-load-probe.mjs`.
- EDGE(WS): `experiments/edge-ws-load-probe.mjs`, `npm run probe:edge:ws`.

Пробники дают повторяемую регрессию поверх замороженных контрактов и не являются
заменой продакшн-SLA §25.11.

**Стабилизация (найдено и устранено в рамках gate).** Под нагрузкой двух
экземпляров ядра (§25.11) конкурентный приём сообщения с одинаковым id
периодически падал на `unique_violation` (SQLSTATE 23505): вставки в
`clients`/`conversations`/`messages` использовали `ON CONFLICT (id)`, который
покрывает только `PRIMARY KEY (id)`, но не композитный `UNIQUE (id,
organization_id)` — при гонке конфликт всплывал по композитному индексу и не
гасился. Исправлено безтаргетным `ON CONFLICT DO NOTHING` и коротким замыканием
на duplicate-путь для `messages` (без задвоения attachments/outbox).
Контракты не затронуты (только стабилизация, §9.3). Регрессия закрыта:
`tests/integration/communication-core-m5.test.mjs` — 20/20 зелёных прогонов
(ранее ~2–3/10 падений).

## 3. Security review (§23)

См. `docs/operations/m5-security-review.md`. Проверены: RLS-изоляция арендаторов
по всем ресурсам, валидация Transform Node, хранение секретов только по ссылке и
ротация, защита append-only аудита, обезличивание ПДн при целостном аудите,
отзыв сессий/доступа. Блокеров нет.

## 4. RPO/RTO и отказоустойчивость

- SVC-DATA: пробное backup/restore в отдельную БД `bridge_restore`, обратимые
  миграции up/down/up — `tests/integration/data-platform.test.mjs`,
  `docs/operations/data-platform-backup-restore.md`.
- SVC-EDGE: авто-синхронизация буфера после восстановления канала, измерения
  `drain().recovery` (`rpo.capacity`, `rpo.ttl_ms`, `rto_ms`) —
  `tests/e2e/edge-resilience-cp9.test.mjs`,
  `tests/integration/edge-message-buffer-store.test.mjs`.

## 5. Полнота OpenAPI и версионирование (§11.14/§11.8, §19.6)

- backend-core OpenAPI генерируется из кода и синхронизирован с реальными
  маршрутами; контрактный прогон без дрейфа —
  `services/backend/test/integration/m5-openapi-contract.spec.ts`,
  `tests/contract/cp9-svc-api-acceptance.test.mjs`.
- `/api/v1` — стабильный URL-контракт; ломающее изменение только через `/api/v2`.
- Мобильный контракт версионируется независимо (`MOBILE.v1 = 1.1.0`), совместим
  по нисходящей с `1.0.0`.

## 6. Критерии приёмки §29 (чек-лист DoD §9.4)

| Критерий §29 / DoD §9.4 | Статус | Улика |
|---|---|---|
| Полный e2e-набор §26.6 зелёный (регрессия) | ✅ | раздел 1 |
| Нагрузка/деградация проверены (§25.11) | ✅ | раздел 2 |
| Security review §23 пройден | ✅ | раздел 3 |
| RPO/RTO подтверждены | ✅ | раздел 4 |
| OpenAPI полон, версионирование без дрейфа | ✅ | раздел 5 |
| Изоляция арендаторов и серверная валидация | ✅ | разделы 1, 3 |
| Аудит изменяющих операций (append-only) | ✅ | раздел 3 |
| Документация §28 завершена | ✅ | `docs/operations/*`, планы сервисов (M5) |
| Все контракты v1 финально заморожены | ✅ | `packages/contracts/cp9-freeze.v1.json` |
| Зелёный CI (lint→unit→build→integration→contract→e2e) | ✅ | `npm run ci`, `npm run test:integration` |

## Итог

Все критерии приёмки §29 выполнены, блокеров нет. Все контракты v1 (C1..C10,
C3.auth/C3.base, C7-события, MOBILE.v1) помечены `released_v1` и заморожены.
Дальнейшие ломающие изменения — только новой версией URL/semver и новым CP
(§7.4/§9.3). Платформа принята к релизу v1.
