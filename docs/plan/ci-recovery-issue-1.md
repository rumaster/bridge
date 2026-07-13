---
title: План восстановления CI базовой ветки issue-1-17113a10fe0c
status: Draft
language: ru-RU
date: 2026-07-13
discovered_in: PR #261 (email attachment GC, ветка claude/keen-booth-e6ed52)
---

# План восстановления CI базовой ветки `issue-1-17113a10fe0c`

## TL;DR

Базовая ветка `issue-1-17113a10fe0c` **красная в CI** по нескольким **независимым**
причинам, не связанным с задачей GC вложений (PR #261). Джоб `lint` падает первым,
а из-за `needs: lint` остальные джобы (`unit`, `build`, `e2e`, `contract`,
`integration`) **пропускаются (skipped)** — поэтому latent-падения `unit`/`contract`
были не видны. Как только чинишь `lint`, каскадом всплывают следующие.

Корень — **незавершённая фича Bridge Mail / вложений M5**: контроллеры добавлены в
код backend, но **производные и governance-артефакты не обновлены**
(опубликованный OpenAPI, каталог api-client, a11y-снапшот, замороженный CP-9
acceptance gate). Плюс **отдельный, независимый баг C6-дескриптора** Web Chat.

Важно: **есть внутреннее противоречие** между двумя контрактными тестами базы
(см. §«Противоречие»), которое нельзя разрешить механически — нужно продуктовое/
governance-решение владельца фичи.

> Эта работа **вне** объёма PR #261 (retention/GC вложений). GC-изменение
> самодостаточно: свои unit-тесты зелёные, живая e2e на стенде — PASS. PR #261
> оставлен «чистым» (только GC); CI в нём красный по причинам базы, описанным здесь.

## Карта падений по джобам CI

### 1. `lint` — `tsc --noEmit` по воркспейсам

- `apps/saas-admin/src/api/mocks/handlers.ts:279` — `validationProblem([...])` в
  обработчике `POST /mail/mailboxes` передаёт `string[]`, а хелпер ждёт
  `{ field: string; message: string }[]` (TS2322).
  **Фикс:** `validationProblem([{ field: "local_part", message: "…" }], "Invalid mailbox name.")`.
- `services/backend/test/unit/integration-gateway.facade.spec.ts:396` — у
  `jest.fn(async () => …)` без типизированных параметров `.mock.calls` — кортеж
  `[]` длины 0, поэтому `c[1]` даёт TS2493/TS2352.
  **Фикс:** дать фабрике параметры: `jest.fn(async (_url?: unknown, _init?: RequestInit) => …)`.

Обе правки тривиальны, локальны, поведение не меняют.

### 2. `unit`

- **saas-admin** `apps/saas-admin/test/m5-acceptance-a11y.test.tsx:158`
  (`toMatchSnapshot`): UI рендерит заголовок «Bridge Mail — заказать ящик»
  (level 2), которого нет в закоммиченном снапшоте.
  **Фикс:** `npm run test --workspace @bridge/saas-admin -- -u` (обновить снапшот;
  диф — только одна строка заголовка).
- **backend** `services/backend/test/integration/m5-openapi-contract.spec.ts:54`
  (`expect(published).toEqual(generated)`): код генерирует эндпоинты
  `/api/v1/mail/mailboxes`, `/api/v1/attachments/{id}/content` и DTO
  `OrderMailbox*`, `AttachmentResponseDto`, `EmailChannel*Credentials*`, которых
  нет в опубликованном `packages/contracts/openapi/backend-core/openapi.json`
  (артефакт отстал от кода: +262/-1 строки).
  **Фикс:** перегенерировать артефакт (см. §«Регенерация OpenAPI»).

### 3. `contract` — `node --test tests/contract/*.test.ts`

- `tests/contract/cp9-svc-api-acceptance.test.ts:68` — «keeps the CP-9 acceptance
  metadata synchronized with backend-core OpenAPI»: количество операций в
  backend-core OpenAPI **ожидается 72, фактически 75** (после регенерации из §2).
  Значение пинится в **замороженном** `packages/contracts/cp9-svc-api-acceptance.v1.json`
  (`generated_operation_count`, `generated_path_count`); файл помечен
  `x-status: "complete"`, `accepted_at: "2026-07-04"`.
  **Фикс: governance-решение** (не механический) — см. §«Противоречие».
- `tests/contract/int-core-c2-c6.test.ts:55` — «publishes a C6 descriptor for Web
  Chat with only M1-supported capabilities enabled»: `expected true / actual
  false`. Тест использует **рантайм** `createWebChatCapabilityDescriptor` и
  константу `C6_CAPABILITIES`; **НЕ читает** OpenAPI. Это **отдельное,
  предсуществующее** падение базы, не связанное ни с GC, ни с регенерацией OpenAPI.
  **Фикс:** привести `createWebChatCapabilityDescriptor` в соответствие с
  ожидаемым M1-набором capability (или тест — к рантайму), по решению владельца C6.

## Противоречие (требует решения владельца фичи)

Два контрактных теста базы **взаимоисключающи** относительно того, входят ли
mail/attachment-эндпоинты в опубликованный контракт v1:

- `m5-openapi-contract.spec.ts` требует, чтобы published == generated-from-code →
  эндпоинты **должны быть** в `openapi.json` (сейчас падает: их нет).
- `cp9-svc-api-acceptance.test.ts` пинит `generated_operation_count = 72` во
  **замороженном** CP-9 gate → эндпоинтов **быть не должно** (сейчас проходит с
  устаревшим артефактом).

Нельзя удовлетворить оба, не приняв решение: **входят ли Bridge Mail/вложения в
CP-9/v1-поверхность**? Фича добавлена в код **после** заморозки CP-9 (2026-07-04).
Варианты:
- (A) Да, входят → перегенерировать `openapi.json`, api-client, снапшот **и**
  обновить замороженный CP-9 gate (72→75, path_count), задокументировать пересмотр
  заморозки. Это правка governance-артефакта — только с ведома владельца контрактов.
- (B) Нет, пока не входят → скрыть mail/attachment-контроллеры из генерации OpenAPI
  до формального включения в следующий CP/версию (тогда `m5-openapi-contract`
  снова сойдётся на 72, gate не трогаем).

## План работ (по шагам)

0. **Governance-решение (блокер):** выбрать (A) или (B) из §«Противоречие».
   Владелец: контракты/Bridge Mail. Без этого шаги 3+ бессмысленны.
1. **lint (тривиально, можно сразу):** применить два фикса из §1.
2. **unit → a11y снапшот:** `-u` для `m5-acceptance-a11y.test.tsx` (одна строка).
3. **unit → OpenAPI (зависит от шага 0):**
   - если (A): перегенерировать `openapi.json` (§«Регенерация OpenAPI») +
     `npm run generate --workspace @bridge/api-client` (иначе `generate:check`
     api-client упадёт в `lint` — это ещё один каскад).
   - если (B): убрать mail/attachment из генерации; артефакт не трогать.
4. **contract → CP-9 (только для (A)):** обновить `cp9-svc-api-acceptance.v1.json`
   (`generated_operation_count` 72→75 и `generated_path_count`), оформить как
   осознанный пересмотр заморозки.
5. **contract → C6 (независимо):** починить `createWebChatCapabilityDescriptor` /
   `int-core-c2-c6.test.ts` (баг не связан с mail; чинится в любом варианте 0).
6. **Прогнать полный CI и следить за дальнейшими каскадами** — не исключены новые
   latent-падения в `contract`/`integration`, ранее маскированные `needs: lint`.

## Регенерация OpenAPI (важный нюанс)

Штатный экспортёр `services/backend/src/tools/export-openapi.ts` (сборка через
`NestFactory` + `app.init()`) **не запускается под `tsx`**: tsx не эмитит
decorator-метаданные, и Nest DI не поднимается (падение на инстанцировании
контроллеров). Он рассчитан на компиляцию `tsc` (`npm run build` →
`node dist/tools/export-openapi.js`).

Рабочий обход для локальной регенерации (тем же способом, что и проверяющий
контрактный тест — через `ts-jest`, который метаданные эмитит): временный jest-spec

```ts
// services/backend/test/regen-openapi.tmp.spec.ts (удалить после прогона)
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { configureBackendApp } from "../src/bootstrap";
import { buildOpenApiDocument } from "../src/common/openapi/openapi";

it("regen", async () => {
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = m.createNestApplication();
  configureBackendApp(app, { installSwaggerUi: false });
  await app.init();
  const out = resolve(__dirname, "../../../packages/contracts/openapi/backend-core/openapi.json");
  writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
  await app.close();
});
```
`npx jest --config jest.config.cjs --runInBand test/regen-openapi.tmp.spec.ts` → затем удалить temp-spec.

**Техдолг:** расхождение `export-openapi.ts` (production build) и способа проверки в
`m5-openapi-contract.spec.ts` стоит устранить — либо чинить экспортёр под запуск без
БД/через ts-node с метаданными, либо привести оба к одному пути генерации.

## Замечание про порядок гейтов CI

Because `unit`/`build`/`e2e`/`contract`/`integration` идут `needs: lint`, красный
`lint` **маскирует** все нижележащие падения. Пока база не зелёная по `lint`,
реальное состояние `unit`/`contract` не видно. Рекомендация: чинить строго по
порядку джобов и после каждого зелёного шага перезапускать полный CI — падения
всплывают каскадом.
