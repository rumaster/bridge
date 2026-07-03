---
title: Issue-трекинг пятой серии промптов (M4)
version: 1.0
status: Done
language: ru-RU
based_on: docs/plan/parallel-stage-5-prompts.md (v1.0)
---

# Issue-трекинг пятой серии промптов (M4)

Закрывает #118: под каждый промпт из
[`parallel-stage-5-prompts.md`](./parallel-stage-5-prompts.md)
(раздел 4, пятая серия промптов для этапа **M4 — Массовые коммуникации + Edge/ПДн**,
точки согласования **CP-6**, **CP-7** и **CP-8**) создан отдельный issue, по
образцу первой, второй, третьей и четвёртой серии (M0, issue #5 → issues #7,
#9–24; M1, issue #44 → issues #46–54; M2, issue #67 → issues #69–79; M3,
issue #96 → issues #98–105).

| Промпт | Issue |
| --- | --- |
| M4-01 — SVC-DATA: схема Broadcast/Notification/Edge и RF-first-контур | [#120](https://github.com/rumaster/bridge/issues/120) |
| M4-02 — SVC-CORE: сквозная идемпотентность, egress, Broadcast и приём от Edge (CP-6/CP-7) | [#121](https://github.com/rumaster/bridge/issues/121) |
| M4-03 — SVC-IDN: self-service bootstrap организаций и приглашения | [#122](https://github.com/rumaster/bridge/issues/122) |
| M4-04 — SVC-API: фасады broadcast-facade (C8) и notification-facade (C10) (CP-6/CP-8) | [#123](https://github.com/rumaster/bridge/issues/123) |
| M4-05 — SVC-INT: ретраи, rate limiting, идемпотентная доставка (CP-6) | [#124](https://github.com/rumaster/bridge/issues/124) |
| M4-06 — SVC-CHAT: подключение клиентов РФ через Edge Cluster (CP-7) | [#125](https://github.com/rumaster/bridge/issues/125) |
| M4-07 — SVC-MWS: лента уведомлений в web (CP-8) | [#126](https://github.com/rumaster/bridge/issues/126) |
| M4-08 — SVC-ADMIN: Broadcast и настройки Notification (CP-6/CP-8) | [#127](https://github.com/rumaster/bridge/issues/127) |
| M4-10 — SVC-FBP: неизменяемые версии, version pinning, stateless-масштабирование | [#128](https://github.com/rumaster/bridge/issues/128) |
| M4-11 — SVC-BCAST: запуск кампаний через единый механизм ядра (CP-6) | [#129](https://github.com/rumaster/bridge/issues/129) |
| M4-12 — SVC-NOTIF: генерация и доставка уведомлений, каналы, настройки, NFR (CP-8) | [#130](https://github.com/rumaster/bridge/issues/130) |
| M4-13 — SVC-EDGE: Edge Cluster РФ, VPN Tunnel, буфер, порядок, дедуп (CP-7, ОСНОВНАЯ работа) | [#131](https://github.com/rumaster/bridge/issues/131) |
| M4-14 — SVC-MOB: агрегация, оффлайн-sync, push, realtime, Edge (CP-7, ОСНОВНАЯ работа) | [#132](https://github.com/rumaster/bridge/issues/132) |
| M4-15 — SVC-TGC: Telegram Console — уведомления, ответ клиенту, AI-подсказки (CP-8) | [#133](https://github.com/rumaster/bridge/issues/133) |
| M4-99 — Интеграционный gate M4 (CP-6 + CP-7 + CP-8) | [#134](https://github.com/rumaster/bridge/issues/134) |

Номер **09** (SVC-AI) в этой серии не используется — у сервиса нет задач на M4
(§ 1.3 исходного документа).

Порядок выполнения — как в разделе 1.2 исходного документа: сначала M4-01
(короткий обязательный предшественник — схема SVC-DATA), затем параллельная
волна трёх сходящихся веток (CP-6: SVC-BCAST + SVC-CORE + SVC-INT + SVC-API;
CP-7: SVC-EDGE + SVC-CORE + SVC-CHAT + SVC-MOB; CP-8: SVC-NOTIF + SVC-API +
SVC-MWS + SVC-TGC + SVC-ADMIN) и блока независимых работ (SVC-IDN, SVC-FBP), и
в конце M4-99 (gate CP-6 + CP-7 + CP-8).
