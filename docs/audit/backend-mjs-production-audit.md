# Аудит `.mjs`-логики backend относительно production `dist/main.js`

**Дата:** 2026-07-04
**Область:** `services/backend/src`, backend-тесты и root e2e/contract/integration
проверки, которые раньше поднимали backend `.mjs`-прототип.

> **Обновление issue #203 (2026-07-05):** миграция распространена на весь
> репозиторий — `.mjs` больше нет ни в одном сервисе. Разделы ниже сохраняют
> исторический контекст issue #192; формулировки про «оставшиеся `.mjs`»
> приведены в соответствие с этим фактом.

## Итог issue #192

Backend `.mjs`-прототип удалён из `services/backend/src`. Production backend
собирается только из TypeScript: `npm run build --workspace=@bridge/backend`
компилирует NestJS entrypoint `src/main.ts`/`src/bootstrap.ts` в `dist/main.js`,
и Docker-образ запускает `node dist/main.js`.

Удалённые backend `.mjs` файлы больше не участвуют ни в runtime, ни в backend
test scripts. После полной миграции репозитория на TypeScript (issue #203)
`.mjs`-файлов не осталось: прочие Node-сервисы (integration-platform,
edge-gateway, broadcast-platform и т.п.) и root contract/e2e тесты также
переведены на `.ts` и не импортируют backend-прототип.

## Production-покрытие вместо backend `.mjs`

- C1/C2 ingress/egress, public conversations/messages, C8 broadcast delivery,
  C9 edge intake, `/metrics` и Telegram login rate-limit проверяются against
  собранного `services/backend/dist/main.js` в
  `tests/e2e/backend-dist-communication-core.test.ts`.
- Реальный NestJS `AppModule` + PostgreSQL/testcontainers покрыт в
  `services/backend/test/integration/internal-messaging.spec.ts`.
- Contract freeze evidence обновлён на production artifacts:
  `internal-messaging.{controller,dto,service}.ts`, `message-status.ts`,
  `edge-intake.service.ts`, `communication-core-m4.dto.ts`.
- Старые prototype-backed root сценарии удалены или заменены на проверки
  смежного сервиса без backend mock.

## Telegram login rate-limit

Rate limiting 429 для `POST /api/v1/auth/login/telegram/start` и
`POST /api/v1/auth/login/telegram/verify` портирован в production NestJS:

- implementation: `services/backend/src/modules/identity/telegram-login-rate-limiter.ts`;
- wiring: `services/backend/src/modules/identity/telegram-auth.service.ts`;
- env: `TELEGRAM_LOGIN_START_RATE_LIMIT`,
  `TELEGRAM_LOGIN_VERIFY_RATE_LIMIT`,
  `TELEGRAM_LOGIN_RATE_LIMIT_WINDOW_SECONDS`;
- defaults: 10 попыток на 60 секунд;
- tests:
  `services/backend/test/unit/telegram-login-rate-limiter.spec.ts`,
  `services/backend/test/integration/telegram-auth.spec.ts`,
  `tests/e2e/backend-dist-communication-core.test.ts`.

Verify rate-limit выполняется до lookup requestId в БД, поэтому повторный перебор
несуществующего requestId тоже получает 429 после исчерпания лимита.

## Статус по пунктам issue #189/#192

1. `POST /internal/ingress/messages` — production NestJS controller/service,
   покрыт integration и dist e2e.
2. `POST /internal/egress/messages` — production NestJS controller/service,
   delivery attempt journal и C2 delivery покрыты integration и dist e2e.
3. Логика M1 Communication Core портирована в TS:
   `message-status.ts`, `internal-messaging.dto.ts`,
   `internal-messaging.service.ts`, `communication-core-proxy.service.ts`.
4. M4 Edge Intake / Broadcast Delivery портированы в TS:
   `communication-core-m4.dto.ts`, `edge-intake.service.ts`,
   `internal-messaging.service.ts`.
5. M5 Adapter Failure / AI Degradation / Load Probe портированы в TS:
   `communication-core-m5.service.ts`, `ai-degradation.guard.ts`,
   `CommunicationCoreLoadProbeService`.
6. Telegram login start/verify работают в NestJS и теперь имеют production
   rate-limit 429.
7. `GET /api/v1/auth/session` остаётся production NestJS endpoint под
   `SessionAuthGuard`.
8. Telegram Bot API delivery остаётся в `telegram-bot.service.ts`; без токена
   используется задокументированная local/CI деградация.
9. `.env.example` содержит `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_BASE_URL` и новые
   rate-limit env variables.
10. Backend `.mjs` дубликаты удалены физически.
11. Backend package scripts больше не запускают `node --test test/*.mjs`;
    backend `test`, `test:unit`, `test:integration` идут через Jest/TS.
12. Production e2e для backend идёт против `dist/main.js`, а не
    `src/main.mjs`/`createBackendServer`.
13. Audit/freeze/docs обновлены на production artifacts и существующие tests.

## Удалённые backend `.mjs` файлы

| Удалённый файл | Production-эквивалент |
|---|---|
| `main.mjs` | `main.ts`, `bootstrap.ts` |
| `common/auth/session-auth-guard.mjs` | `common/auth/session-auth.guard.ts` |
| `backend-api/m0-api-module.mjs` | `modules/health/*`, production controllers |
| `communication-core/communication-core-m1.mjs` | `internal-messaging.{controller,dto,service}.ts`, `message-status.ts`, `communication-core-proxy.service.ts` |
| `communication-core/communication-core-module.mjs` | NestJS modules/controllers in `communication-core-proxy.module.ts` |
| `communication-core/index.mjs` | нет runtime-эквивалента; compatibility barrel удалён |
| `communication-core/mock-ingress-egress.mjs` | production tests use real NestJS/Postgres or local HTTP egress fixture |
| `identity/dto/auth-dto.mjs` | `telegram-auth.dto.ts`, `identity-m4.dto.ts` |
| `identity/identity-controller.mjs` | `telegram-auth.controller.ts`, `identity-m4.controller.ts`, `user.controller.ts` |
| `identity/identity-module.mjs` | `telegram-auth.module.ts`, `identity-m4.module.ts` |
| `identity/identity-service.mjs` | `telegram-auth.service.ts`, `identity-m4.service.ts`, `audit.service.ts`, `telegram-login-rate-limiter.ts` |
| `identity/seeded-auth-context.mjs` | PostgreSQL fixtures/seeds in tests and migrations |

## Удалённые backend-prototype tests

Удалены backend-local `.mjs` unit/integration тесты под
`services/backend/test/**/*.mjs` и root prototype-backed сценарии, которые
импортировали `services/backend/src/main.mjs`,
`communication-core/index.mjs` или `mock-ingress-egress.mjs`.

Root-тесты (после issue #203 — `.ts`, запускаются через `node --import tsx`)
либо проверяют отдельные Node-сервисы (integration-platform, edge-gateway,
broadcast-platform и т.п.), также переведённые на `.ts`, либо работают
с production backend через `dist/main.js`.

## Ссылки на прототип в production TS

Комментарии в production TS могут ссылаться на исходный прототип как на источник
портирования, например `communication-core-m1` в doc-комментариях
`internal-messaging.dto.ts`/`internal-messaging.service.ts`. После issue #203
расширение `.mjs` из этих комментариев убрано (файлов-прототипов не осталось);
ссылки не являются runtime dependency и не требуют сохранения файлов.

Для проверки отсутствия runtime-coupling использовать:

```bash
rg -n "from .*services/backend/src/.*\\.mjs|createBackendServer|createCommunicationCoreMock"
```
