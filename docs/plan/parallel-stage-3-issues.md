---
title: Issue-трекинг третьей серии промптов (M2)
version: 1.0
status: Done
language: ru-RU
based_on: docs/plan/parallel-stage-3-prompts.md (v1.0)
---

# Issue-трекинг третьей серии промптов (M2)

Закрывает #67: под каждый промпт из
[`parallel-stage-3-prompts.md`](./parallel-stage-3-prompts.md)
(раздел 4, третья серия промптов для этапа **M2 — Омниканальность + realtime +
AI Assistant**, точки согласования **CP-2** и **CP-3**) создан отдельный
issue, по образцу первой и второй серии (M0, issue #5 → issues #7, #9–24; M1,
issue #44 → issues #46–54).

| Промпт | Issue |
| --- | --- |
| M2-01 — SVC-DATA: pgvector, Knowledge Base, identity links, каналы | [#69](https://github.com/rumaster/bridge/issues/69) |
| M2-02 — SVC-CORE: identity resolution, порядок, realtime (C7) | [#70](https://github.com/rumaster/bridge/issues/70) |
| M2-03 — SVC-IDN: полноценный RBAC по ролям | [#71](https://github.com/rumaster/bridge/issues/71) |
| M2-04 — SVC-API: Knowledge Base API (C3.kb) | [#72](https://github.com/rumaster/bridge/issues/72) |
| M2-05 — SVC-INT: адаптеры Telegram/Email/SMS/VK/MAX/WhatsApp и Capability Model | [#73](https://github.com/rumaster/bridge/issues/73) |
| M2-06 — SVC-CHAT: AI-ответы, полная история, realtime по WS (C7) | [#74](https://github.com/rumaster/bridge/issues/74) |
| M2-07 — SVC-MWS: realtime по WS и панель AI-подсказок (CP-3) | [#75](https://github.com/rumaster/bridge/issues/75) |
| M2-08 — SVC-ADMIN: разделы «Каналы связи» и «Knowledge Base» | [#76](https://github.com/rumaster/bridge/issues/76) |
| M2-09 — SVC-AI: AI Assistant, пайплайн RAG (CP-3) | [#77](https://github.com/rumaster/bridge/issues/77) |
| M2-13 — SVC-EDGE: WebSocket Gateway на стороне Application Cluster | [#78](https://github.com/rumaster/bridge/issues/78) |
| M2-99 — Интеграционный gate M2 (CP-2 + CP-3) | [#79](https://github.com/rumaster/bridge/issues/79) |

Порядок выполнения — как в разделе 1.2 исходного документа: сначала M2-01
(обязательный предшественник), затем параллельная волна M2-02…M2-09, M2-13
(ветки CP-2 и CP-3 + realtime), и в конце M2-99 (gate CP-2 + CP-3).
