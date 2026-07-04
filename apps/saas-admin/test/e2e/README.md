# SaaS Administration Playwright

Сквозные админ-сценарии против C3/C4/C5/C8/C10 MSW-моков (`VITE_SAAS_ADMIN_MOCKS=true`):

- `saas-admin.auth.spec.ts` — «Авторизация» (M1, C3.auth/C3.org).
- `saas-admin.m2.spec.ts` — каналы связи и Knowledge Base (M2, C3.channels/C3.kb).
- `saas-admin.m3.spec.ts` — редактор Workflow и AI Onboarding (M3, C5/C4).
- `saas-admin.m4.spec.ts` — Broadcast и Notification (M4, C8/C10).
- `saas-admin.m5.spec.ts` — приёмка (M5, CP-9): общий прогон всех разделов из
  одного входа (мастер §8.2), доступность (skip-link, лендмарки) и адаптивность
  Desktop/Tablet (ТЗ §21.8).

Структурная визуальная регрессия ключевых экранов и проверки доступности в jsdom —
в `test/m5-acceptance-a11y.test.tsx` (Vitest). Запуск e2e: `npm run test:e2e`
(ставит Chromium и поднимает dev-сервер с моками).
