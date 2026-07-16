import { TRANSFORM_DEFAULT_LIMITS, execInputPortIds } from "@bridge/contracts/c5-workflow";
import { getNodeDefinition } from "../nodes/registry.js";
import { WorkflowExecutionError } from "./errors.js";
import { buildGraph } from "./graph.js";

// Предел числа шагов как защита «в глубину»: граф — DAG (проверено контрактом на
// сохранении), поэтому реальная длина пути ограничена числом узлов, но лимит
// страхует от любых патологий и гарантирует завершимость (ТЗ §13.13-п.5).
const DEFAULT_MAX_NODE_STEPS = 10000;
const DEFAULT_EXEC_PORT = "out";

/**
 * Исполнение графа Workflow — гибрид push/pull (Ревизия 2026-07-15, решение A1).
 *
 * Push: очередь FIFO идёт по exec-связям и задаёт порядок. Один exec-выход может
 * вести в несколько узлов — так начинаются параллельные потоки; узел `merge` ждёт
 * прихода всех своих входов и пропускает поток дальше ровно один раз.
 *
 * Pull: узлы-функции (`transform`, `variable_read`) exec-портов не имеют и в
 * очередь не попадают вовсе. Их выход вычисляется лениво — в тот момент, когда
 * значение понадобилось узлу ниже по data-связи, — и мемоизируется, чтобы два
 * потребителя не считали одно и то же дважды.
 *
 * Точка входа: для схемы верхнего уровня — узел `wait-event`, на котором сработало
 * событие (`startNodeId`); для субсхемы — её узел `start`. Прежний `schema.entry`
 * упразднён.
 *
 * Возвращает `{ status, output, journal, trace }`. Трасса пишется по каждому узлу
 * и различает `via: "flow" | "data"` — иначе постфактум не понять, почему
 * pure-узел исполнился (или не исполнился вовсе).
 */
export async function runGraph({
  schema,
  ctx,
  backendClient,
  limits = TRANSFORM_DEFAULT_LIMITS,
  maxNodeSteps = DEFAULT_MAX_NODE_STEPS,
  subSchemaStack = [],
  startNodeId = null,
  nodePath = [],
  depth = 0,
}) {
  const graph = buildGraph(schema);
  const results = new Map();
  const trace = [];
  const arrivals = new Map();
  const resolving = new Set();
  let steps = 0;

  const startNodes = resolveStartNodes(schema, graph, startNodeId);

  ctx.appendJournal("workflow.started", {
    data: {
      workflow_id: schema.workflow_id ?? null,
      workflow_version_id: schema.workflow_version_id ?? null,
      start: startNodes.map((node) => node.id),
    },
  });

  /**
   * Выходы узла-источника для data-связи. Если источник — exec-узел, который ещё
   * не отработал, вернётся null: значение просто не попадёт во вход потребителя.
   * Если источник — pure-узел, он вычисляется здесь же (pull) и мемоизируется.
   */
  async function resolveSourceOutputs(nodeId) {
    const memo = results.get(nodeId);
    if (memo) return memo.outputs;

    const node = graph.getNode(nodeId);
    if (!node) return null;
    if (execInputPortIds(node, schema).length > 0) return null;

    if (resolving.has(nodeId)) {
      throw new WorkflowExecutionError(
        "data_cycle",
        `Циклическая зависимость по данным около узла "${nodeId}".`,
        { nodeId },
      );
    }
    const result = await executeNode(node, "data");
    return result.outputs;
  }

  async function resolveNodeInputs(node) {
    const inputs = {};
    for (const connection of graph.dataConnectionsTo(node.id)) {
      const sourceOutputs = await resolveSourceOutputs(connection.from);
      if (sourceOutputs && Object.hasOwn(sourceOutputs, connection.fromPort)) {
        // Ключ входа — имя ВХОДНОГО порта потребителя, а не выходного источника.
        inputs[connection.toPort] = sourceOutputs[connection.fromPort];
      }
    }
    return inputs;
  }

  async function executeNode(node, via) {
    const definition = getNodeDefinition(node.type);
    if (!definition) {
      throw new WorkflowExecutionError("unknown_node_type", `Неизвестный тип узла "${node.type}".`, {
        nodeId: node.id,
        nodeType: node.type,
      });
    }

    resolving.add(node.id);
    let inputs;
    try {
      inputs = await resolveNodeInputs(node);
    } finally {
      resolving.delete(node.id);
    }

    ctx.appendJournal("node.started", { nodeId: node.id, data: { type: node.type, via } });
    const startedAt = ctx.elapsedMs();

    let raw;
    try {
      raw = await definition.execute({
        node,
        input: inputs,
        ctx,
        backendClient,
        limits,
        runSubSchema: (slug, subInput = inputs) =>
          runSubSchema({
            slug,
            input: subInput,
            ctx,
            backendClient,
            limits,
            maxNodeSteps,
            subSchemaStack,
            nodePath: [...nodePath, node.id],
            depth,
          }),
      });
    } catch (error) {
      trace.push({
        nodeId: node.id,
        type: node.type,
        via,
        durationMs: ctx.elapsedMs() - startedAt,
        inputs,
        outputs: null,
        failed: true,
        message: error?.message ?? String(error),
        nodePath: [...nodePath, node.id],
        depth,
      });
      ctx.appendJournal("node.failed", {
        nodeId: node.id,
        data: { type: node.type, reason: error?.reason ?? "error", message: error?.message ?? String(error) },
      });
      throw decorateError(error, node);
    }

    const result = {
      outputs: raw?.outputs ?? {},
      execPort: raw?.execPort ?? DEFAULT_EXEC_PORT,
    };
    results.set(node.id, result);
    ctx.setNodeOutput(node.id, result.outputs);

    trace.push({
      nodeId: node.id,
      type: node.type,
      via,
      durationMs: ctx.elapsedMs() - startedAt,
      inputs,
      outputs: result.outputs,
      failed: false,
      nodePath: [...nodePath, node.id],
      depth,
    });
    ctx.appendJournal("node.completed", {
      nodeId: node.id,
      data: {
        type: node.type,
        via,
        port: result.execPort,
        ...(raw?.log !== undefined ? { log: raw.log } : {}),
      },
    });

    return result;
  }

  const queue = startNodes.map((node) => node.id);
  const executed = new Set();
  let lastOutputs = null;

  try {
    while (queue.length > 0) {
      if (steps >= maxNodeSteps) {
        throw new WorkflowExecutionError(
          "step_budget_exceeded",
          `Превышен бюджет шагов исполнения (${maxNodeSteps}) — исполнение остановлено.`,
        );
      }

      const nodeId = queue.shift();
      if (executed.has(nodeId)) continue;

      const node = graph.getNode(nodeId);
      if (!node) {
        throw new WorkflowExecutionError("unknown_node", `Узел "${nodeId}" отсутствует в графе.`, { nodeId });
      }

      // merge — барьер: пропускаем дальше только когда пришли ВСЕ входящие потоки.
      if (node.type === "merge" && (arrivals.get(nodeId) ?? 0) < graph.incomingExecCount(nodeId)) {
        continue;
      }

      steps += 1;
      executed.add(nodeId);
      const result = await executeNode(node, "flow");
      lastOutputs = result.outputs;

      for (const connection of graph.execConnectionsFrom(node.id)) {
        // Ветвление продолжает исполнение только по выбранной ветке.
        if (node.type === "branch" && connection.fromPort !== result.execPort) continue;
        arrivals.set(connection.to, (arrivals.get(connection.to) ?? 0) + 1);
        queue.push(connection.to);
      }
    }
  } catch (error) {
    // Трасса — локальный массив, поэтому при выбросе она пропадала вместе с кадром
    // стека: вызывающий получал ошибку без единого шага исполнения. Именно на
    // падении трасса и нужнее всего — тест-прогон должен показать, ДО какого узла
    // схема дошла и с какими входами упала. Прикрепляем её к ошибке и бросаем
    // дальше: семантика для существующих вызывающих не меняется.
    attachTrace(error, trace);
    throw error;
  }

  ctx.appendJournal("workflow.completed", { data: { steps } });
  return {
    status: "completed",
    output: collectFinalOutput(schema, graph, results, lastOutputs),
    journal: ctx.journal,
    trace,
  };
}

/**
 * Прикрепить трассу к ошибке.
 *
 * Вложенность разрешается в пользу ВНЕШНЕЙ трассы: субсхема бросает первой и
 * прикрепляет свою, но внешний `runGraph` ловит ту же ошибку выше по стеку и
 * перекрывает её. Это не потеря, а согласованность — на успешном прогоне трасса
 * субсхемы тоже не всплывает наверх (узел `sub_schema` читает только `output`), и
 * падение не должно возвращать трассу другой формы, чем успех. Сама субсхема в
 * трассе родителя присутствует — своим узлом с `failed: true` и сообщением.
 *
 * Поле неперечислимое: ошибка сериализуется в журнал и в ответ C5, и трасса не
 * должна попадать туда вторым, несогласованным экземпляром.
 */
function attachTrace(error, trace) {
  if (!error || typeof error !== "object") return;

  Object.defineProperty(error, "trace", {
    configurable: true,
    enumerable: false,
    value: [...trace],
    writable: true,
  });
}

function resolveStartNodes(schema, graph, startNodeId) {
  if (schema.kind === "subschema") {
    const start = [...graph.nodeMap.values()].find((node) => node.type === "start");
    if (!start) {
      throw new WorkflowExecutionError("missing_start", "Субсхема обязана содержать узел start.");
    }
    return [start];
  }

  if (typeof startNodeId !== "string" || startNodeId === "") {
    throw new WorkflowExecutionError(
      "missing_start",
      "Не указан узел «Ожидание события», с которого начинается исполнение.",
    );
  }

  const node = graph.getNode(startNodeId);
  if (!node) {
    throw new WorkflowExecutionError("unknown_node", `Стартовый узел "${startNodeId}" отсутствует в графе.`, {
      nodeId: startNodeId,
    });
  }
  if (node.type !== "wait-event") {
    throw new WorkflowExecutionError(
      "invalid_start_node",
      `Исполнение начинается только с узла «Ожидание события», получен "${node.type}".`,
      { nodeId: startNodeId, nodeType: node.type },
    );
  }
  return [node];
}

/** Итог субсхемы — входы её узла end; итог схемы верхнего уровня — выход последнего узла. */
function collectFinalOutput(schema, graph, results, lastOutputs) {
  if (schema.kind !== "subschema") return lastOutputs ?? null;
  const end = [...graph.nodeMap.values()].find((node) => node.type === "end");
  return end ? results.get(end.id)?.outputs ?? {} : {};
}

async function runSubSchema({
  slug,
  input,
  ctx,
  backendClient,
  limits,
  maxNodeSteps,
  subSchemaStack,
  nodePath,
  depth,
}) {
  const normalized = String(slug ?? "").trim();
  if (normalized === "") {
    throw new WorkflowExecutionError("invalid_subschema_ref", "Ссылка на субсхему должна быть непустой строкой.");
  }
  if (subSchemaStack.includes(normalized)) {
    throw new WorkflowExecutionError(
      "subschema_cycle",
      `Обнаружена рекурсивная ссылка на субсхему "${normalized}".`,
      { nodeType: "sub_schema" },
    );
  }

  const schema = await ctx.resolveSubSchema(normalized);
  // Дочерний контекст изолирован: переменные родителя в субсхему не протекают —
  // она общается с ним только через граничные порты start/end.
  const childCtx = ctx.createChild({ input });
  return runGraph({
    schema,
    ctx: childCtx,
    backendClient,
    limits,
    maxNodeSteps,
    subSchemaStack: [...subSchemaStack, normalized],
    nodePath,
    depth: depth + 1,
  });
}

function decorateError(error, node) {
  if (error instanceof WorkflowExecutionError) {
    error.nodeId = error.nodeId ?? node.id;
    error.nodeType = error.nodeType ?? node.type;
    return error;
  }
  const reason = typeof error?.reason === "string" && error.reason !== ""
    ? error.reason
    : "node_execution_error";
  return new WorkflowExecutionError(reason, error?.message ?? String(error), {
    nodeId: node.id,
    nodeType: node.type,
  });
}
