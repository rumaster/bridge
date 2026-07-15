import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_API_OPERATIONS } from "@bridge/contracts/backend-api-catalog";
import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { WorkflowSchemaValidationError } from "../../src/core/errors.js";
import { assertWorkflowSchema, validateWorkflowSchema } from "../../src/schema/validate-workflow.js";

const POST_OP = BACKEND_API_OPERATIONS.find(
  (op) => op.method === "POST" && op.path_params.length === 0 && op.has_body,
)!;
const PATH_PARAM_OP = BACKEND_API_OPERATIONS.find((op) => op.path_params.length === 1)!;

/**
 * Ревизия 2026-07-15: валидатор движка больше не дублирует правила графа — форму,
 * порты, типы и циклы проверяет контракт C5 (`validateWorkflowGraphContract`),
 * общий с Backend и редактором. Своего у валидатора остался только конфиг узлов по
 * правилам реестра — прежде всего лимиты песочницы, которых контракт не знает.
 *
 * Контракт бросает на ПЕРВОМ нарушении, поэтому в каждом тесте схема ломается
 * ровно в одном месте: иначе проверялся бы порядок проверок, а не правило.
 */
function validSchema(): any {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    nodes: [
      { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
      {
        id: "t",
        type: "transform",
        position: { x: 0, y: 0 },
        config: { code: "return input.src;", inputs: [{ name: "src", type: "object" }], outputs: [{ name: "value", type: "any" }] },
      },
      { id: "w", type: "variable_write", position: { x: 0, y: 0 }, config: { inputs: [{ name: "payload", type: "any" }] } },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" },
      { id: "c2", from: "evt", fromPort: "data", to: "t", toPort: "src" },
      { id: "c3", from: "t", fromPort: "value", to: "w", toPort: "payload" },
    ],
  };
}

function subSchema(): any {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "subschema",
    nodes: [
      { id: "s", type: "start", position: { x: 0, y: 0 }, config: { outputs: [{ id: "query", label: "Запрос", type: "string" }] } },
      { id: "e", type: "end", position: { x: 0, y: 0 }, config: { inputs: [{ id: "result", label: "Ответ", type: "string" }] } },
    ],
    connections: [
      { id: "c1", from: "s", fromPort: "out", to: "e", toPort: "in" },
      { id: "c2", from: "s", fromPort: "query", to: "e", toPort: "result" },
    ],
  };
}

function pathsOf(result: any) {
  return result.errors.map((error: any) => error.path);
}

function messagesOf(result: any) {
  return result.errors.map((error: any) => error.message).join(" | ");
}

describe("Валидация схемы Workflow: делегирование контракту C5", () => {
  it("принимает корректную схему 2.0", () => {
    const result = validateWorkflowSchema(validSchema());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  });

  it("принимает корректную субсхему со start/end", () => {
    const result = validateWorkflowSchema(subSchema());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it("отвергает не-объект", () => {
    for (const bad of [null, "схема", 42, []]) {
      assert.equal(validateWorkflowSchema(bad).valid, false, `${JSON.stringify(bad)} не схема`);
    }
  });

  it("отвергает схему прежней версии — формат 2.0 ломающий (решение A4)", () => {
    const schema = validSchema();
    schema.schema_version = "1.0.0";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.schema_version"));
  });

  it("отвергает неизвестный тип узла", () => {
    const schema = validSchema();
    schema.nodes[1].type = "sql-exec";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.match(messagesOf(result), /sql-exec/);
  });

  it("отвергает дублирующиеся id узлов", () => {
    const schema = validSchema();
    schema.nodes[1].id = "evt";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=evt]"));
  });

  it("отвергает узел, недоступный в этом виде графа", () => {
    const schema = validSchema();
    schema.nodes.push({ id: "s", type: "start", position: { x: 0, y: 0 }, config: { outputs: [] } });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.match(messagesOf(result), /недоступен в графе вида/);
  });

  it("требует источник исполнения: workflow без узла события запускать нечем", () => {
    const schema = validSchema();
    schema.nodes = schema.nodes.filter((node: any) => node.type !== "wait-event");
    schema.connections = [];
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes"));
  });

  it("субсхема обязана иметь ровно один start и один end", () => {
    const noStart = subSchema();
    noStart.nodes = noStart.nodes.filter((node: any) => node.type !== "start");
    noStart.connections = [];
    assert.equal(validateWorkflowSchema(noStart).valid, false);

    const twoStarts = subSchema();
    twoStarts.nodes.push({ id: "s2", type: "start", position: { x: 0, y: 0 }, config: { outputs: [] } });
    assert.equal(validateWorkflowSchema(twoStarts).valid, false);
  });

  it("требует ациклический exec-граф (DAG)", () => {
    const schema = validSchema();
    // w.out → evt.in невозможен (у события нет exec-входа), поэтому цикл строим
    // на паре узлов с exec-портами.
    schema.nodes.push({ id: "w2", type: "variable_write", position: { x: 0, y: 0 }, config: { inputs: [{ name: "a", type: "any" }] } });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "w2", toPort: "in" });
    schema.connections.push({ id: "c5", from: "w2", fromPort: "out", to: "w", toPort: "in" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.connections"));
  });

  it("отвергает связь в несуществующий узел", () => {
    const schema = validSchema();
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "ghost", toPort: "in" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.connections"));
  });

  it("требует явные fromPort/toPort в связях", () => {
    const schema = validSchema();
    schema.connections = [{ id: "c1", from: "evt", to: "w" }];
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
  });

  it("отвергает связь с несуществующим портом", () => {
    const missingOutput = validSchema();
    missingOutput.connections[1].fromPort = "нет-такого";
    const outputResult = validateWorkflowSchema(missingOutput);
    assert.equal(outputResult.valid, false);
    // Ошибка указывает на УЗЕЛ-владелец порта, а не на связь: чинить надо порт.
    assert.ok(pathsOf(outputResult).includes("$.nodes[id=evt]"));

    const missingInput = validSchema();
    missingInput.connections[1].toPort = "нет-такого";
    const inputResult = validateWorkflowSchema(missingInput);
    assert.equal(inputResult.valid, false);
    assert.ok(pathsOf(inputResult).includes("$.nodes[id=t]"));
  });

  it("отвергает смешение exec-порта и data-порта в одной связи", () => {
    const schema = validSchema();
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "t", toPort: "src" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.match(messagesOf(result), /смешивает exec-порт и data-порт/);
  });

  it("отвергает второе ребро в тот же data-вход (у входа один источник)", () => {
    const schema = validSchema();
    schema.connections.push({ id: "c4", from: "evt", fromPort: "data", to: "w", toPort: "payload" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=w]"));
  });

  it("отвергает несовместимые типы портов", () => {
    const schema = validSchema();
    schema.nodes[1].config.outputs = [{ name: "value", type: "object" }];
    schema.nodes[2].config.inputs = [{ name: "payload", type: "string" }];
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.match(messagesOf(result), /Несовместимые порты/);
    assert.ok(pathsOf(result).includes("$.connections"));
  });

  it("тип any совместим с любым — это осознанное послабление, а не дыра", () => {
    const schema = validSchema();
    // Выход transform объявлен как any: контракт обязан пропустить его в строковый
    // вход, иначе нетипизированный JS-код нельзя было бы подключить никуда.
    schema.nodes[2].config.inputs = [{ name: "payload", type: "string" }];
    assert.equal(validateWorkflowSchema(schema).valid, true);
  });
});

describe("Валидация схемы Workflow: конфигурация узлов", () => {
  it("отвергает попытку узла Backend API подменить арендатора (§13.13-п.4)", () => {
    for (const key of ["organization_id", "organizationId", "actor_user_id", "context"]) {
      const schema = validSchema();
      schema.nodes.push({
        id: "call",
        type: "backend-api",
        position: { x: 0, y: 0 },
        config: { operation_id: POST_OP.operation_id, [key]: "подмена" },
      });
      schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "call", toPort: "in" });
      const result = validateWorkflowSchema(schema);
      assert.equal(result.valid, false, `ключ ${key} должен быть отклонён`);
      assert.match(messagesOf(result), new RegExp(`запрещённый ключ config\\.${key}`));
    }
  });

  it("отвергает вызов Backend API вне каталога — произвольный путь задать нельзя", () => {
    const schema = validSchema();
    schema.nodes.push({
      id: "call",
      type: "backend-api",
      position: { x: 0, y: 0 },
      config: { operation_id: "НетТакойОперации" },
    });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "call", toPort: "in" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=call]"));
  });

  it("требует входной порт под каждый плейсхолдер пути операции", () => {
    const schema = validSchema();
    schema.nodes.push({
      id: "call",
      type: "backend-api",
      position: { x: 0, y: 0 },
      config: { operation_id: PATH_PARAM_OP.operation_id },
    });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "call", toPort: "in" });
    // Плейсхолдер без одноимённого входа гарантированно упал бы в рантайме.
    assert.equal(validateWorkflowSchema(schema).valid, false);

    schema.nodes[3].config.inputs = PATH_PARAM_OP.path_params.map((name) => ({ name, type: "string" }));
    assert.equal(validateWorkflowSchema(schema).valid, true, JSON.stringify(validateWorkflowSchema(schema).errors));
  });

  it("отвергает transform без кода", () => {
    const schema = validSchema();
    schema.nodes[1].config.code = "   ";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=t]"));
  });

  it("отвергает узел ветвления без корректного оператора", () => {
    const schema = validSchema();
    schema.nodes.push({ id: "b", type: "branch", position: { x: 0, y: 0 }, config: { operator: "приблизительно" } });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "b", toPort: "in" });
    assert.equal(validateWorkflowSchema(schema).valid, false);
  });

  it("отвергает узел события с типом вне реестра — подписка молча не сработала бы", () => {
    const schema = validSchema();
    schema.nodes[0].config.event_type = "никто.не.публикует";
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=evt]"));
  });

  it("отвергает sub_schema без subSchemaSlug", () => {
    const schema = validSchema();
    schema.nodes.push({ id: "sub", type: "sub_schema", position: { x: 0, y: 0 }, config: {} });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "sub", toPort: "in" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[id=sub]"));
  });
});

/**
 * Лимиты песочницы — единственное, что валидатор движка считает САМ: контракт о
 * них не знает (он грузится и браузером, и Backend), а превышение обязано быть
 * пойманным на сохранении, а не на первом запуске.
 */
describe("Валидация схемы Workflow: лимиты песочницы (ТЗ §13.13-п.5)", () => {
  it("отвергает код transform сверх maxCodeLength", () => {
    const schema = validSchema();
    schema.nodes[1].config.code = "x".repeat(100);
    const result = validateWorkflowSchema(schema, { limits: { maxCodeLength: 10 } });
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).includes("$.nodes[1].config.code"));
    assert.match(messagesOf(result), /превышает лимит 10 байт/);
  });

  it("принимает код в пределах лимита", () => {
    const schema = validSchema();
    assert.equal(validateWorkflowSchema(schema, { limits: { maxCodeLength: 65536 } }).valid, true);
  });

  it("отвергает недопустимый timeout_ms узла Backend API", () => {
    const schema = validSchema();
    schema.nodes.push({
      id: "call",
      type: "backend-api",
      position: { x: 0, y: 0 },
      config: { operation_id: POST_OP.operation_id, timeout_ms: 0 },
    });
    schema.connections.push({ id: "c4", from: "w", fromPort: "out", to: "call", toPort: "in" });
    const result = validateWorkflowSchema(schema);
    assert.equal(result.valid, false);
    assert.ok(pathsOf(result).some((path: string) => path.endsWith(".timeout_ms")));
  });
});

describe("assertWorkflowSchema", () => {
  it("бросает WorkflowSchemaValidationError со списком ошибок", () => {
    const schema = validSchema();
    schema.nodes[1].type = "unknown";
    assert.throws(
      () => assertWorkflowSchema(schema),
      (error) => error instanceof WorkflowSchemaValidationError && Array.isArray(error.errors) && error.errors.length > 0,
    );
  });

  it("возвращает схему без изменений при корректном вводе", () => {
    const schema = validSchema();
    assert.equal(assertWorkflowSchema(schema), schema);
  });
});
