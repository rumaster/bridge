import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.mjs";
import { getNodeDefinition } from "../nodes/registry.mjs";
import { WorkflowExecutionError } from "./errors.mjs";
import { buildGraph, DEFAULT_PORT } from "./graph.mjs";

// Предел числа шагов как защита «в глубину»: граф — DAG (проверено на сохранении),
// поэтому реальная длина пути ограничена числом узлов, но лимит страхует от любых
// патологий и гарантирует завершимость (ТЗ §13.13-п.5).
const DEFAULT_MAX_NODE_STEPS = 10000;

/**
 * Пошаговое исполнение графа Workflow (ТЗ §13.13-п.1). Ядро предметно-нейтрально:
 * начинает со стартового узла `schema.entry`, для каждого узла собирает `input`
 * из объявленной «проводки», исполняет его через определение из реестра, пишет в
 * журнал события `node.started`/`node.completed` и переходит по соединению,
 * соответствующему эмитированному порту. Останавливается, когда переходов нет
 * (успех) или узел перевёл экземпляр в состояние ожидания (`waiting`).
 *
 * Возвращает `{ status, output, journal, wait?, waitingNodeId? }`. Ошибки времени
 * исполнения фиксируются событием `node.failed` и пробрасываются наверх — фасад
 * оборачивает их в `workflow.failed` и всегда возвращает журнал.
 *
 * Для stateless-исполнителя (ТЗ §25.3) поддерживается ПРОДОЛЖЕНИЕ с произвольного
 * узла: если задан `startNodeId`, обход стартует не с `entry`, а с указанного
 * узла — контекст (`ctx`) при этом восстановлен из `workflow_instance_state`, так
 * что другой узел-исполнитель без памяти между шагами продолжает тот же экземпляр
 * на его зафиксированной версии.
 */
export async function runGraph({
  schema,
  ctx,
  backendClient,
  limits = TRANSFORM_DEFAULT_LIMITS,
  maxNodeSteps = DEFAULT_MAX_NODE_STEPS,
  resume = false,
  startNodeId = null,
  resumeOutput = null,
}) {
  const graph = buildGraph(schema);

  if (resume && startNodeId !== null && !graph.getNode(startNodeId)) {
    throw new WorkflowExecutionError(
      "unknown_node",
      `Узел продолжения "${startNodeId}" отсутствует в графе зафиксированной версии.`,
      { nodeId: startNodeId },
    );
  }

  ctx.appendJournal(resume ? "workflow.resumed" : "workflow.started", {
    data: {
      workflow_id: schema.workflow_id ?? null,
      workflow_version_id: schema.workflow_version_id ?? null,
      entry: graph.entry,
      ...(resume ? { resume_from: startNodeId } : {}),
    },
  });

  // При продолжении (stateless resume, ТЗ §25.3) обход начинается с узла-преемника
  // ожидавшего события. Если преемника нет, экземпляр завершается сразу, а итоговым
  // выходом остаётся результат ожидания (`resumeOutput`).
  let currentId = resume ? startNodeId : graph.entry;
  let lastOutput = resume ? resumeOutput : null;
  let steps = 0;

  while (currentId) {
    if (steps >= maxNodeSteps) {
      throw new WorkflowExecutionError(
        "step_budget_exceeded",
        `Превышен бюджет шагов исполнения (${maxNodeSteps}) — исполнение остановлено.`,
        { nodeId: currentId },
      );
    }
    steps += 1;

    const node = graph.getNode(currentId);
    if (!node) {
      throw new WorkflowExecutionError("unknown_node", `Узел "${currentId}" отсутствует в графе.`, {
        nodeId: currentId,
      });
    }

    const definition = getNodeDefinition(node.type);
    if (!definition) {
      throw new WorkflowExecutionError("unknown_node_type", `Неизвестный тип узла "${node.type}".`, {
        nodeId: node.id,
        nodeType: node.type,
      });
    }

    const input = ctx.assembleInput(node.input);
    ctx.appendJournal("node.started", { nodeId: node.id, data: { type: node.type } });

    let result;
    try {
      result = await definition.execute({ node, input, ctx, backendClient, limits });
    } catch (error) {
      ctx.appendJournal("node.failed", {
        nodeId: node.id,
        data: { type: node.type, reason: error?.reason ?? "error", message: error?.message ?? String(error) },
      });
      throw decorateError(error, node);
    }

    const output = result?.output ?? null;
    const port = result?.port ?? DEFAULT_PORT;
    ctx.setNodeOutput(node.id, output);
    lastOutput = output;

    ctx.appendJournal("node.completed", {
      nodeId: node.id,
      data: { type: node.type, port, ...(result?.log !== undefined ? { log: result.log } : {}) },
    });

    if (result?.waiting) {
      ctx.appendJournal("workflow.waiting", {
        nodeId: node.id,
        data: { wait: result.wait ?? null },
      });
      return {
        status: "waiting",
        output,
        wait: result.wait ?? null,
        waitingNodeId: node.id,
        journal: ctx.journal,
      };
    }

    currentId = graph.next(node.id, port);
  }

  ctx.appendJournal("workflow.completed", { data: { steps } });
  return { status: "completed", output: lastOutput, journal: ctx.journal };
}

function decorateError(error, node) {
  if (error instanceof WorkflowExecutionError) {
    error.nodeId = error.nodeId ?? node.id;
    error.nodeType = error.nodeType ?? node.type;
    return error;
  }
  return new WorkflowExecutionError("node_execution_error", error?.message ?? String(error), {
    nodeId: node.id,
    nodeType: node.type,
  });
}
