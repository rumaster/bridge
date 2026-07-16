import type { PoolClient } from "pg";

import type { PgDatabase } from "../../src/common/database/database.service";
import { WorkflowSubschemaService } from "../../src/modules/workflow/workflow-subschema.service";

/**
 * Write-эндпоинты субсхем (дефект D3).
 *
 * Редактор звал `POST`/`PATCH /workflow-subschemas` с самого начала, но контроллер
 * имел только `GET` — в проде 404, работало лишь против MSW-моков. Проверяется не
 * столько «сохраняет», сколько два решения, на которых это держится: заготовка
 * рождается валидной, а граф проверяется ПОЛНОСТЬЮ, без послабления A10.
 */

const ORG = "30000000-0000-4000-8000-000000000101";
const SUBSCHEMA_ID = "30000000-0000-4000-8000-000000000841";

interface RecordedQuery {
  params: unknown[];
  text: string;
}

function makeDatabase(
  queries: RecordedQuery[],
  { duplicate = false, found = true }: { duplicate?: boolean; found?: boolean } = {},
): PgDatabase {
  const client = {
    async query(text: string, params: unknown[] = []) {
      queries.push({ params, text });

      if (text.includes("SELECT 1 FROM workflow_subschemas")) {
        return { rowCount: duplicate ? 1 : 0, rows: duplicate ? [{ "?column?": 1 }] : [] };
      }

      if (text.includes("INSERT INTO workflow_subschemas")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: params[0],
              organization_id: params[1],
              slug: params[2],
              name: params[3],
              schema: JSON.parse(params[4] as string),
              status: "draft",
              created_at: "2026-07-15T10:00:00.000Z",
              updated_at: "2026-07-15T10:00:00.000Z",
            },
          ],
        };
      }

      if (text.includes("UPDATE workflow_subschemas")) {
        return found
          ? {
              rowCount: 1,
              rows: [
                {
                  id: params[1],
                  organization_id: params[0],
                  slug: "support-common-context",
                  name: (params[3] as string) ?? "Общий контекст",
                  schema: params[5] ? JSON.parse(params[5] as string) : {},
                  status: "active",
                  created_at: "2026-07-15T10:00:00.000Z",
                  updated_at: "2026-07-15T10:05:00.000Z",
                },
              ],
            }
          : { rowCount: 0, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  return {
    async withTenant<T>(_organizationId: string, callback: (c: PoolClient) => Promise<T>) {
      return callback(client);
    },
  } as unknown as PgDatabase;
}

function validSubschema() {
  return {
    schema_version: "2.0.0",
    kind: "subschema",
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, config: { outputs: [] } },
      { id: "end", type: "end", position: { x: 400, y: 0 }, config: { inputs: [] } },
    ],
    connections: [{ id: "c1", from: "start", fromPort: "out", to: "end", toPort: "in" }],
  };
}

describe("WorkflowSubschemaService: write-эндпоинты (D3)", () => {
  it("создаёт субсхему валидной заготовкой с границами start/end", async () => {
    // Без границ субсхема не прошла бы валидацию при первом же сохранении, и
    // редактор встретил бы оператора списком ошибок вместо холста.
    const queries: RecordedQuery[] = [];
    const service = new WorkflowSubschemaService(makeDatabase(queries));

    const created = await service.createSubschema(ORG, {
      slug: "support-common-context",
      name: "Общий контекст поддержки",
    });

    expect(created.slug).toBe("support-common-context");
    expect(created.status).toBe("draft");
    expect(created.schema.kind).toBe("subschema");

    const nodeTypes = (created.schema.nodes as { type: string }[]).map((node) => node.type);
    expect(nodeTypes).toEqual(["start", "end"]);
  });

  it("новая субсхема — draft, а не active", async () => {
    // sub_schema ссылается только на активные: пустая заготовка не должна
    // немедленно стать доступной для ссылок.
    const queries: RecordedQuery[] = [];
    const service = new WorkflowSubschemaService(makeDatabase(queries));

    const created = await service.createSubschema(ORG, { slug: "draft-one", name: "Черновая" });

    expect(created.status).toBe("draft");
  });

  it("отвергает занятый slug: на него ссылаются графы", async () => {
    const service = new WorkflowSubschemaService(makeDatabase([], { duplicate: true }));

    await expect(
      service.createSubschema(ORG, { slug: "support-common-context", name: "Дубль" }),
    ).rejects.toMatchObject({
      response: { code: "WORKFLOW_SUBSCHEMA_SLUG_TAKEN" },
      status: 409,
    });
  });

  it("сохраняет валидный граф субсхемы", async () => {
    const queries: RecordedQuery[] = [];
    const service = new WorkflowSubschemaService(makeDatabase(queries));

    const updated = await service.updateSubschema(ORG, SUBSCHEMA_ID, { schema: validSubschema() });

    expect(updated.id).toBe(SUBSCHEMA_ID);
    expect(queries.some((query) => query.text.includes("UPDATE workflow_subschemas"))).toBe(true);
  });

  it("проверяет граф ПОЛНОСТЬЮ: послабление A10 для драфтов здесь не действует", async () => {
    // У субсхемы нет драфта и промоута — узел sub_schema подхватывает актуальный
    // граф по slug, то есть любое сохранение сразу боевое. Недостроенную субсхему
    // сохранить нельзя: она обрушит уже работающие схемы.
    const queries: RecordedQuery[] = [];
    const service = new WorkflowSubschemaService(makeDatabase(queries));
    const broken = { ...validSubschema(), nodes: [{ id: "x", type: "нет-такого", position: { x: 0, y: 0 }, config: {} }] };

    await expect(service.updateSubschema(ORG, SUBSCHEMA_ID, { schema: broken })).rejects.toMatchObject({
      response: { code: "WORKFLOW_SCHEMA_INVALID" },
    });
    // До базы дело не дошло.
    expect(queries.some((query) => query.text.includes("UPDATE workflow_subschemas"))).toBe(false);
  });

  it("отвергает граф, сохранённый как workflow вместо subschema", async () => {
    // Иначе субсхема осталась бы без границ start/end, и это упало бы в рантайме у
    // ссылающейся схемы, а не здесь.
    const service = new WorkflowSubschemaService(makeDatabase([]));
    const wrongKind = { ...validSubschema(), kind: "workflow" };

    await expect(
      service.updateSubschema(ORG, SUBSCHEMA_ID, { schema: wrongKind }),
    ).rejects.toMatchObject({ response: { code: "WORKFLOW_SCHEMA_INVALID" } });
  });

  it("сообщает 404, когда субсхемы нет", async () => {
    const service = new WorkflowSubschemaService(makeDatabase([], { found: false }));

    await expect(
      service.updateSubschema(ORG, SUBSCHEMA_ID, { name: "Новое имя" }),
    ).rejects.toMatchObject({
      response: { code: "WORKFLOW_SUBSCHEMA_NOT_FOUND" },
      status: 404,
    });
  });
});
