import { TRANSFORM_DEFAULT_LIMITS } from "@bridge/contracts/c5-workflow";
import { ExecutionContext } from "../core/execution-context.js";
import { WorkflowExecutionError, WorkflowStoreError } from "../core/errors.js";
import { runGraph } from "../core/executor.js";
import { deterministicUuid } from "../core/ids.js";
import type { BackendApiClient } from "../backend/client.js";

/** Опции сборки оркестратора {@link createInstanceRuntime}. */
export interface InstanceRuntimeOptions {
  backendClient?: BackendApiClient;
  versions?: any;
  instances?: any;
  metrics?: any;
  limits?: Record<string, unknown>;
  resolveSubSchema?: any;
  now?: () => string;
}

/** Аргументы запуска экземпляра ({@link createInstanceRuntime} `start`). */
export interface StartInstanceOptions {
  organizationId?: string;
  workflowId?: string;
  context?: any;
  input?: Record<string, unknown>;
  versionId?: string;
  instanceId?: string;
  /** Узел «Ожидание события», на котором сработала подписка. */
  startNodeId?: string;
}

/**
 * Оркестратор жизненного цикла экземпляров Workflow.
 *
 * **Version pinning** (ТЗ §13.10): `start` закрепляет экземпляр за версией
 * (явной или версией по умолчанию) в `workflow_instances` — публикация новой
 * версии на идущий экземпляр не влияет.
 *
 * Ревизия 2026-07-15: `resume` и статус `waiting` удалены. Узел «Ожидание
 * события» перестал быть паузой посреди схемы и стал ТОЧКОЙ ВХОДА: событие не
 * будит спящий экземпляр, а запускает новый — с того узла, чья подписка
 * совпала (`startNodeId`). Вместе с ними ушли снимки в
 * `workflow_instance_state`: исполнение стало сквозным, хранить нечего.
 * Прежний resume и так был нерабочим — он не сверял ни тип события, ни
 * корреляцию, а наружу не выставлялся вовсе.
 *
 * Инициатор Workflow — всегда Backend (§6.13): `context` с арендатором/актором
 * задаёт вызывающая сторона, движок сам экземпляры не запускает.
 */
export function createInstanceRuntime({
  backendClient,
  versions,
  instances,
  metrics = null,
  limits = {},
  resolveSubSchema = null,
  now = () => new Date().toISOString(),
}: InstanceRuntimeOptions = {}) {
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
   * Запустить экземпляр Workflow с узла «Ожидание события», чья подписка
   * совпала. Закрепляет версию (version pinning) и исполняет граф до конца:
   * `completed` либо `failed`.
   */
  async function start({
    organizationId,
    workflowId,
    context,
    input = {},
    versionId,
    instanceId,
    startNodeId,
  }: StartInstanceOptions = {}) {
    const org = requireOrg(organizationId, context);
    requireId(workflowId, "workflow_id");
    requireId(startNodeId, "start_node_id");

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
    // Метрика §24.6: запуск считается ОДИН раз на старте; `resume` — продолжение
    // того же экземпляра и заново `runs` не инкрементирует.
    metrics?.recordStart({ workflowId });

    const ctx = createContext({ context, org, version, input, instanceId: resolvedInstanceId });
    return execute({ ctx, version, instanceId: resolvedInstanceId, organizationId: org, startNodeId });
  }

  async function execute({ ctx, version, instanceId, organizationId, startNodeId }) {
    let result;
    try {
      result = await runGraph({
        schema: version.schema,
        ctx,
        backendClient,
        limits: effectiveLimits,
        startNodeId,
      });
    } catch (error) {
      ctx.appendJournal("workflow.failed", {
        nodeId: error?.nodeId ?? null,
        data: { reason: error?.reason ?? "error", message: error?.message ?? String(error) },
      });
      const finishedAt = now();
      instances.updateInstance({ organizationId, instanceId, status: "failed", finishedAt });
      recordTerminal({ organizationId, instanceId, workflowId: version.workflow_id, status: "failed", finishedAt });
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

    const finishedAt = now();
    instances.updateInstance({ organizationId, instanceId, status: "completed", finishedAt });
    instances.clearState({ organizationId, instanceId });
    recordTerminal({ organizationId, instanceId, workflowId: version.workflow_id, status: "completed", finishedAt });
    return {
      instance_id: instanceId,
      organization_id: organizationId,
      version_id: version.id,
      version_no: version.version_no,
      status: "completed",
      output: result.output,
      journal: ctx.journal,
      trace: result.trace,
    };
  }

  return { start };

  // Метрика §24.6: перевод экземпляра в терминальное состояние. Длительность —
  // разница меток `started_at`/`finished_at` (детерминирована при инъекции `now`).
  function recordTerminal({ organizationId, instanceId, workflowId, status, finishedAt }) {
    if (!metrics) {
      return;
    }
    let durationMs = 0;
    try {
      const instance = instances.getInstance({ organizationId, instanceId });
      durationMs = durationBetween(instance.started_at, finishedAt);
    } catch {
      durationMs = 0;
    }
    metrics.recordCompletion({ workflowId, status, durationMs });
  }

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
      resolveSubSchema,
      resolvedSubSchemas: version.schema?.__resolved_subschemas ?? null,
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

// Длительность между ISO-метками в миллисекундах; неотрицательна и устойчива к
// некорректным/равным меткам (при фиксированном `now` в тестах даёт 0).
function durationBetween(startedAt, finishedAt) {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) {
    return 0;
  }
  return Math.max(0, finish - start);
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
