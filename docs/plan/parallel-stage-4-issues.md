---
title: Issue-трекинг четвёртой серии промптов (M3)
version: 1.0
status: Done
language: ru-RU
based_on: docs/plan/parallel-stage-4-prompts.md (v1.0)
---

# Issue-трекинг четвёртой серии промптов (M3)

Закрывает #96: под каждый промпт из
[`parallel-stage-4-prompts.md`](./parallel-stage-4-prompts.md)
(раздел 4, четвёртая серия промптов для этапа **M3 — Программируемость**, точки
согласования **CP-4** и **CP-5**) создан отдельный issue, по образцу первой,
второй и третьей серии (M0, issue #5 → issues #7, #9–24; M1, issue #44 →
issues #46–54; M2, issue #67 → issues #69–79).

| Промпт | Issue |
| --- | --- |
| M3-01 — SVC-DATA: схема Workflow (`workflow_*`) и транзакционный outbox (C-OUT) | [#98](https://github.com/rumaster/bridge/issues/98) |
| M3-02 — SVC-CORE: доменные события для Workflow (транзакционный outbox) | [#99](https://github.com/rumaster/bridge/issues/99) |
| M3-03 — SVC-IDN: аудит действий аутентификации и управления доступом | [#100](https://github.com/rumaster/bridge/issues/100) |
| M3-04 — SVC-API: фасады AI/FBP (устойчивость), узел Backend API, интеграция аудита | [#101](https://github.com/rumaster/bridge/issues/101) |
| M3-08 — SVC-ADMIN: визуальный редактор Workflow и AI Onboarding (CP-5) | [#102](https://github.com/rumaster/bridge/issues/102) |
| M3-09 — SVC-AI: AI Onboarding, структурированные команды (CP-5) | [#103](https://github.com/rumaster/bridge/issues/103) |
| M3-10 — SVC-FBP: форк fbp-engine, узел Backend API, безопасный Transform Node (CP-4/CP-5) | [#104](https://github.com/rumaster/bridge/issues/104) |
| M3-99 — Интеграционный gate M3 (CP-4 + CP-5) | [#105](https://github.com/rumaster/bridge/issues/105) |

Порядок выполнения — как в разделе 1.2 исходного документа: сначала M3-01
(короткий обязательный предшественник — схема SVC-DATA), затем параллельная
волна M3-02…M3-10 (ветка CP-4: SVC-API + SVC-FBP; ветка CP-5: SVC-ADMIN +
SVC-AI; инфраструктура ядра: SVC-CORE + SVC-IDN), и в конце M3-99 (gate
CP-4 + CP-5).
