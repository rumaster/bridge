---
title: Issue-трекинг второй серии промптов (M1)
version: 1.0
status: Done
language: ru-RU
based_on: docs/plan/parallel-stage-2-prompts.md (v1.0)
---

# Issue-трекинг второй серии промптов (M1)

Закрывает #44: под каждый промпт из
[`docs/plan/parallel-stage-2-prompts.md`](https://github.com/rumaster/bridge/blob/issue-41-28c5e6a17855/docs/plan/parallel-stage-2-prompts.md)
(раздел 4, вторая серия промптов для вехи **M1 — Вертикальный срез «приём и
ответ»**, точка согласования **CP-1**) создан отдельный issue, по образцу
первой серии (M0, issue #5 → issues #7, #9–24).

| Промпт | Issue |
| --- | --- |
| M1-01 — SVC-DATA: базовые таблицы вертикального среза | [#46](https://github.com/rumaster/bridge/issues/46) |
| M1-02 — SVC-CORE: Ingress/Egress, хранение и маршрутизация | [#47](https://github.com/rumaster/bridge/issues/47) |
| M1-03 — SVC-IDN: Telegram-логин, сессии, базовый guard | [#48](https://github.com/rumaster/bridge/issues/48) |
| M1-04 — SVC-API: доменные CRUD и проксирование ядра | [#49](https://github.com/rumaster/bridge/issues/49) |
| M1-05 — SVC-INT: Web Chat Adapter и C6 Web Chat | [#50](https://github.com/rumaster/bridge/issues/50) |
| M1-06 — SVC-CHAT: обмен сообщениями через ядро | [#51](https://github.com/rumaster/bridge/issues/51) |
| M1-07 — SVC-MWS: очередь, история, отправка ответа | [#52](https://github.com/rumaster/bridge/issues/52) |
| M1-08 — SVC-ADMIN: вход, организация и конфигурация | [#53](https://github.com/rumaster/bridge/issues/53) |
| M1-99 — Интеграционный gate M1 (CP-1) | [#54](https://github.com/rumaster/bridge/issues/54) |

Порядок выполнения — как в разделе 5 исходного документа: сначала M1-01
(обязательный предшественник), затем параллельная волна M1-02…M1-08, и в
конце M1-99 (gate CP-1).
