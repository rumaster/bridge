import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.mjs";
import { ExecutionContext } from "../core/execution-context.mjs";
import { WorkflowExecutionError, WorkflowStoreError } from "../core/errors.mjs";
import { buildGraph, DEFAULT_PORT } from "../core/graph.mjs";
import { runGraph } from "../core/executor.mjs";
import { deterministicUuid } from "../core/ids.mjs";

/**
 * Оркестратор жизненного цикла экземпляров Workflow вехи M4 — связывает три
 * механизма поверх доменно-нейтрального ядра исполнения:
 *
 *  - **version pinning** (ТЗ §13.10): `start` закрепляет экземпляр за версией
 *    (явной или версией по умолчанию) в `workflow_instances`; `resume` всегда
 *    поднимает СХЕМУ ЗАФИКСИРОВАННОЙ версии — публикация новой версии на идущий
 *    экземпляр не влияет;
 *  - **stateless executor** (ТЗ §25.3): при переходе в ожидание снимок состояния
 *    сохраняется в `workflow_instance_state`; продолжение (`resume`) поднимает
 *    контекст из хранилища — исполнителю не нужна память между шагами;
 *  - **горизонтальное масштабирование** (ТЗ §25.3): `resume` может выполнить
 *    ДРУГОЙ узел-исполнитель (другой `createInstanceRuntime` поверх того же
 *    хранилища) — любой узел обрабатывает любой экземпляр.
 *
 * Инициатор Workflow — всегда Backend (§6.13): `context` с арендатором/актором
 * задаёт вызывающая сторона, движок сам экземпляры не запускает.
 */
export function createInstanceRuntime({
  backendClient,
  versions,
  instances,
  limits = {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!backendClient || typeof backendClient.call !== "function") {
    throw new TypeError(
      "createInstanceRuntime требует backendClient с методом call — данные идут только через Backend API (C3).",
    );
  }
  if (!versions || typeof versions.resolveVersion !== "function") {
    throw new TypeError("createInstanceRuntime требует реестр версий (createVersionRegistry).");
  }
  if (!instances || typeof instances.createInstance !== "function") {
    throw new TypeError("createInstanceRuntime требует хранилище экземпляров (createInstanceStore).");
  }
  const effectiveLimits = Object.freeze({ ...TRANSFORM_DEFAULT_LIMITS, ...limits });

  /**
   * Запустить экземпляр Workflow. Закрепляет версию (version pinning) и исполняет
   * граф. Если экземпляр ушёл в ожидание — снимок состояния уходит в
   * `workflow_instance_state`, статус `waiting`; при завершении — `completed`/`failed`.
   */
  async function start({ organizationId, workflowId, context, input = {}, versionId, instanceId } = {}) {
    const org = requireOrg(organizationId, context);
    requireId(workflowId, "workflow_id");

    // Version pinning: версия выбирается ОДИН РАЗ на старте и фиксируется.
    const version = versions.resolveVersion({ organizationId: org, workflowId, versionId });
    const resolvedInstanceId = instanceId ?? deterministicUuid([org, workflowId, version.id, stableStringify(input)]);

    instances.createInstance({
      organizationId: org,
      workflowId,
      versionId: version.id,
      instanceId: resolvedInstanceId,
      status: "running",
    });

    const ctx = createContext({ context, org, version, input, instanceId: resolvedInstanceId });
    return execute({ ctx, version, instanceId: resolvedInstanceId, organizationId: org });
  }

  /**
   * Продолжить ожидающий экземпляр после прихода события. Поднимает состояние из
   * `workflow_instance_state` и схему ЗАФИКСИРОВАННОЙ версии — может выполняться
   * на другом узле-исполнителе (stateless, §25.3).
   */
  async function resume({ organizationId, instanceId, event = null } = {}) {
    requireId(organizationId, "organization_id");
    requireId(instanceId, "instance_id");

    const instance = instances.getInstance({ organizationId, instanceId });
    if (instance.status !== "waiting") {
      throw new WorkflowStoreError(
        "instance_not_waiting",
        `Экземпляр "${instanceId}" не в состоянии ожидания (статус "${instance.status}").`,
      );
    }

    const snapshot = instances.loadState({ organizationId, instanceId });
    if (!snapshot || !snapshot.cursor || typeof snapshot.cursor.waiting_node_id !== "string") {
      throw new WorkflowStoreError(
        "instance_state_missing",
        `Для экземпляра "${instanceId}" нет снимка состояния для продолжения.`,
      );
    }

    // Ключевой инвариант pinning: берём версию, ЗАКРЕПЛЁННУЮ за экземпляром, а не
    // текущую версию по умолчанию — даже если опубликована новая.
    const version = versions.getVersion({
      organizationId,
      workflowId: instance.workflow_id,
      versionId: instance.version_id,
    });

    const ctx = ExecutionContext.fromSnapshot(snapshot, { now });
    const waitingNodeId = snapshot.cursor.waiting_node_id;
    // Событие разрешает ожидание: узел wait-event отдаёт наследникам данные события.
    ctx.setNodeOutput(waitingNodeId, event);
    const graph = buildGraph(version.schema);
    const resumeFrom = graph.next(waitingNodeId, DEFAULT_PORT);

    return execute({
      ctx,
      version,
      instanceId,
      organizationId,
      resume: { startNodeId: resumeFrom, resumeOutput: event },
    });
  }

  async function execute({ ctx, version, instanceId, organizationId, resume: resumeOpts = null }) {
    let result;
    try {
      result = await runGraph({
        schema: version.schema,
        ctx,
        backendClient,
        limits: effectiveLimits,
        ...(resumeOpts
          ? { resume: true, startNodeId: resumeOpts.startNodeId, resumeOutput: resumeOpts.resumeOutput }
          : {}),
      });
    } catch (error) {
      ctx.appendJournal("workflow.failed", {
        nodeId: error?.nodeId ?? null,
        data: { reason: error?.reason ?? "error", message: error?.message ?? String(error) },
      });
      instances.updateInstance({ organizationId, instanceId, status: "failed", finishedAt: now() });
      return {
        instance_id: instanceId,
        organization_id: organizationId,
        version_id: version.id,
        version_no: version.version_no,
        status: "failed",
        output: null,
        error: {
          reason: error?.reason ?? "error",
          message: error?.message ?? String(error),
          node_id: error?.nodeId ?? null,
          node_type: error?.nodeType ?? null,
        },
        journal: ctx.journal,
      };
    }

    if (result.status === "waiting") {
      // Stateless: снимок уходит во внешнее хранилище, исполнитель памяти не держит.
      const snapshot = ctx.snapshot();
      snapshot.cursor = { waiting_node_id: result.waitingNodeId, wait: result.wait ?? null };
      instances.saveState({ organizationId, instanceId, state: snapshot });
      instances.updateInstance({ organizationId, instanceId, status: "waiting" });
      return {
        instance_id: instanceId,
        organization_id: organizationId,
        version_id: version.id,
        version_no: version.version_no,
        status: "waiting",
        output: result.output,
        wait: result.wait ?? null,
        waiting_node_id: result.waitingNodeId,
        journal: ctx.journal,
      };
    }

    instances.updateInstance({ organizationId, instanceId, status: "completed", finishedAt: now() });
    instances.clearState({ organizationId, instanceId });
    return {
      instance_id: instanceId,
      organization_id: organizationId,
      version_id: version.id,
      version_no: version.version_no,
      status: "completed",
      output: result.output,
      journal: ctx.journal,
    };
  }

  return { start, resume };

  function createContext({ context, org, version, input, instanceId }) {
    return new ExecutionContext({
      organizationId: org,
      actorUserId: context?.actor_user_id ?? null,
      trigger: context?.trigger ?? null,
      roles: context?.roles ?? [],
      correlationId: context?.correlation_id ?? null,
      locale: context?.locale ?? null,
      instanceId,
      workflowId: version.workflow_id,
      workflowVersionId: version.id,
      input,
      now,
    });
  }
}

function requireOrg(organizationId, context) {
  const org = organizationId ?? context?.organization_id;
  if (typeof org !== "string" || org.trim() === "") {
    throw new WorkflowExecutionError(
      "invalid_context",
      "start требует organization_id — инициатор Workflow всегда Backend (§6.13).",
    );
  }
  return org;
}

function requireId(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowStoreError("invalid_argument", `${field} должен быть непустой строкой.`);
  }
  return value;
}

// Детерминированная сериализация с сортировкой ключей — instance_id одинаков при
// одинаковом входе независимо от порядка ключей (без ГСЧ/времени).
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
