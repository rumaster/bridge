# SVC-FBP — движок исполнения Workflow (M3-10, M4-10)

Форк `fbp-engine`, переработанный под платформу (ТЗ §13.13): доменно-нейтральное
ядро исполнения графа, узел Backend API как единственный санкционированный способ
менять данные и безопасный Transform Node. Реализация clean-room —
см. [`LICENSE-NOTE.md`](./LICENSE-NOTE.md).

Веха **M4-10** добавила поверх ядра три механизма (аддитивно, без изменения набора
узлов, узла Backend API и Transform Node из M3): **неизменяемые версии схем**,
**version pinning** и **stateless-исполнитель** с горизонтальным масштабированием.

## Слои

- `src/core/*` — доменно-нейтральное ядро: граф (`graph.mjs`, Node/Connection,
  проверка DAG), `ExecutionContext` (арендатор, актор, журнал), пошаговый
  `executor.mjs`, детерминированные идентификаторы (`ids.mjs`, без ГСЧ/времени).
- `src/nodes/*` — нейтральный набор узлов и реестр (`registry.mjs`).
- `src/transform/*` — безопасный вычислитель выражений Transform Node.
- `src/schema/validate-workflow.mjs` — валидация схемы **на этапе сохранения**.
- `src/backend/client.mjs` — клиент Backend API (канал C3) и мок с изоляцией
  арендаторов для тестов.
- `src/versions/version-registry.mjs` — реестр **неизменяемых версий** схем
  (M4): публикация правки = НОВАЯ версия, перезапись отклоняется, версия по
  умолчанию переключается конфигурацией.
- `src/state/instance-store.mjs` — референс-модель `workflow_instances`
  (закрепление версии) и `workflow_instance_state` (**внешнее** состояние).
- `src/runtime/instance-runtime.mjs` — оркестратор `start`/`resume` с version
  pinning и stateless-продолжением.
- `src/engine.mjs` — прикладные фасады (`createFbpEngine`, `createFbpRuntime`).

> `src/server.mjs`, `src/deterministic-fbp.mjs`, `src/c5-dto.mjs`, `src/main.mjs`
> — замороженный детерминированный C5-сервер этапа M0 (wire-контракт CP-4/CP-5).
> Движок M3 добавлен аддитивно и его не затрагивает.

## Публичный API

```js
import { createFbpEngine } from "./src/engine.mjs";

const engine = createFbpEngine({ backendClient /* { call(request) } */ });

// CP-5: валидация на этапе сохранения новой версии (§16.7).
const { valid, errors } = engine.validateSchema(schema);

// CP-4: пошаговое исполнение экземпляра.
const result = await engine.runWorkflow({
  schema,
  context: { organization_id, actor_user_id, trigger }, // задаёт Backend (§6.13)
  input: { /* параметры запуска */ },
});
// result: { instance_id, organization_id, status, output, journal, ... }
```

## Рантайм M4: версии, pinning, stateless-масштабирование (§13.10, §25.3)

```js
import { createFbpRuntime } from "./src/engine.mjs";

const runtime = createFbpRuntime({ backendClient });

// Неизменяемые версии: публикация правки — это НОВАЯ версия (не перезапись).
const v1 = runtime.publishVersion({ organizationId, workflowId, schema: schemaV1 });
const v2 = runtime.publishVersion({ organizationId, workflowId, schema: schemaV2 });
runtime.setDefaultVersion({ organizationId, workflowId, versionId: v2.id }); // конфигурацией

// Version pinning: экземпляр закрепляется за версией на старте.
const started = await runtime.start({ organizationId, workflowId, context, input });
// → status: "waiting" при узле wait-event; состояние ушло в workflow_instance_state.

// Stateless: продолжить может ДРУГОЙ узел-исполнитель над тем же хранилищем.
const nodeB = createFbpRuntime({ backendClient, versions: runtime.versions, instances: runtime.instances });
const done = await nodeB.resume({ organizationId, instanceId: started.instance_id, event });
// → доигрывается на ЗАКРЕПЛЁННОЙ версии, даже если default уже переключён.
```

- **Неизменяемые версии** (§13.10): каждая правка порождает новую версию с
  монотонным `version_no`; попытка перезаписать существующую версию отклоняется
  (`VersionImmutabilityError`); опубликованная схема заморожена (`deepFreeze`).
  Зеркалит ограничения БД `UNIQUE(workflow_id, version_no)` и триггер
  `workflow_versions_immutable`.
- **Version pinning** (§13.10): идущий экземпляр исполняется до конца на своей
  версии; публикация новой версии влияет только на последующие старты;
  переключение версии по умолчанию — конфигурацией (`setDefaultVersion`).
- **Stateless-исполнитель** (§25.3): при переходе в ожидание снимок состояния
  выносится в `workflow_instance_state` (через Backend); исполнитель не держит
  память между шагами — любой узел продолжает любой экземпляр по внешнему
  состоянию. Так моделируется горизонтальное масштабирование (нагрузочная
  приёмка — веха M5, вне охвата M4).

## Нейтральный набор узлов (§13.13-п.1)

| Тип | Назначение |
| --- | --- |
| `backend-api` | Вызов Backend API — **единственный** способ читать/менять данные (§13.5). |
| `llm` | Вызов LLM через AI-фасад Backend (C3). |
| `knowledge-base-search` | Поиск в Knowledge Base через Backend (C3). |
| `branch` | Ветвление по булеву выражению Transform. |
| `transform` | Безопасное декларативное преобразование данных (§13.4). |
| `wait-event` | Перевод экземпляра в ожидание внешнего события. |

Каталог заморожен в `packages/contracts/src/c5.mjs` (`FBP_NODE_TYPES`) и сверяется
контрактным тестом `tests/contract/c5-fbp-node-catalog.test.mjs`. Доменных/БД-узлов
исходного проекта нет.

## Гарантии безопасности

- **Нет прямого доступа к БД/сети/ФС** (§13.13-п.3, §13.12): движок не исполняет
  SQL; данные — только через переданный `backendClient` (C3). `createFbpEngine`
  падает без него.
- **Инициатор — всегда Backend** (§6.13): движок сам Workflow не запускает,
  `organization_id`/актора задаёт `context`.
- **Мультиарендность** (§13.13-п.4, §22.6): исполнение привязано к
  `organization_id`; узлы не могут подменить арендатора (валидация запрещает
  `organization_id`/`context` в конфиге узла Backend API).
- **Безопасный Transform** (§13.13-п.5): декларативный AST над whitelist
  (`TRANSFORM_ALLOWED_OPERATIONS`); операции вне whitelist отклоняются **при
  сохранении схемы**, а не в рантайме. Нет доступа к окружению/сети/ФС/секретам/
  системному времени/ГСЧ/произвольному коду; защита от prototype pollution;
  ограничения по числу шагов и размеру результата (`TRANSFORM_DEFAULT_LIMITS`).

## Журнал исполнения (§13.9, §24.6)

`runWorkflow` всегда возвращает `journal` — массив записей формы таблицы
`workflow_execution_logs` (`id, organization_id, instance_id, node_id, event,
data, created_at`). События: `workflow.started`, `node.started`,
`node.completed`, `node.failed`, `workflow.completed`, `workflow.failed`,
`workflow.waiting`. Движок в БД не пишет — журнал сохраняет Backend.

## Тесты

```sh
npm test --workspace @bridge/fbp-engine   # unit + integration сервиса
npm run test:contract                      # контракт C5 (каталог узлов, whitelist)
npm run test:e2e                           # CP-4/CP-5 на реальном движке
```
