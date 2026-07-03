import { deterministicUuid } from "./ids.mjs";
import { WorkflowExecutionError } from "./errors.mjs";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Контекст исполнения одного экземпляра Workflow (ТЗ §13.13-п.4, §22.6).
 *
 * Мультиарендность «по построению»: контекст ЖЁСТКО привязан к одному
 * `organization_id`. Узлы не могут ни прочитать, ни переопределить арендатора —
 * вызовы Backend API всегда идут от имени этого арендатора (§13.5). Прямого
 * доступа к БД/секретам/среде у контекста нет — только параметры Workflow,
 * результаты ранее исполненных узлов и журнал.
 */
export class ExecutionContext {
  #organizationId;
  #actorUserId;
  #trigger;
  #roles;
  #correlationId;
  #locale;
  #instanceId;
  #workflowId;
  #workflowVersionId;
  #params;
  #outputs = new Map();
  #journal = [];
  #now;
  #seq = 0;

  constructor({
    organizationId,
    actorUserId,
    trigger,
    roles = [],
    correlationId = null,
    locale = null,
    instanceId,
    workflowId,
    workflowVersionId,
    input = {},
    now = () => new Date().toISOString(),
  }) {
    if (typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new WorkflowExecutionError(
        "invalid_context",
        "ExecutionContext требует непустой organization_id (мультиарендность §13.13-п.4).",
      );
    }
    this.#organizationId = organizationId;
    this.#actorUserId = actorUserId;
    this.#trigger = trigger;
    this.#roles = Array.isArray(roles) ? [...roles] : [];
    this.#correlationId = correlationId;
    this.#locale = locale;
    this.#instanceId = instanceId;
    this.#workflowId = workflowId;
    this.#workflowVersionId = workflowVersionId;
    this.#params = input ?? {};
    this.#now = now;
  }

  get organizationId() {
    return this.#organizationId;
  }

  get instanceId() {
    return this.#instanceId;
  }

  get params() {
    return this.#params;
  }

  hasNodeOutput(nodeId) {
    return this.#outputs.has(nodeId);
  }

  getNodeOutput(nodeId) {
    return this.#outputs.get(nodeId);
  }

  setNodeOutput(nodeId, value) {
    this.#outputs.set(nodeId, value);
  }

  /**
   * Собрать `input` узла из объявленной «проводки» (ТЗ §13.4). Transform Node и
   * прочие узлы видят ТОЛЬКО этот собранный объект, а не весь контекст —
   * источники: параметры Workflow (`params`), результат другого узла (`node`)
   * или константа схемы (`const`).
   */
  assembleInput(inputSpec) {
    if (inputSpec === undefined || inputSpec === null) {
      return {};
    }
    const result = {};
    for (const [key, source] of Object.entries(inputSpec)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      Object.defineProperty(result, key, {
        value: this.resolveSource(source),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }

  resolveSource(source) {
    if (!isRecord(source)) {
      throw new WorkflowExecutionError("invalid_input_source", "Источник входа узла повреждён.");
    }
    switch (source.kind) {
      case "const":
        return clone(source.value ?? null);
      case "params":
        return accessPath(this.#params, source.path ?? []);
      case "node": {
        if (!this.#outputs.has(source.node)) {
          throw new WorkflowExecutionError(
            "unknown_node_reference",
            `Источник ссылается на неисполненный узел "${source.node}".`,
          );
        }
        return accessPath(this.#outputs.get(source.node), source.path ?? []);
      }
      default:
        throw new WorkflowExecutionError(
          "invalid_input_source",
          `Неизвестный тип источника входа "${source.kind}".`,
        );
    }
  }

  /**
   * Контекст вызова для узла Backend API (C5 ExecutionContext). Арендатор,
   * актор и триггер берутся ИЗ контекста экземпляра — узел не может их подменить
   * (§13.5, §13.13-п.4).
   */
  toCallContext() {
    return {
      organization_id: this.#organizationId,
      actor_user_id: this.#actorUserId,
      trigger: this.#trigger,
      roles: [...this.#roles],
      ...(this.#correlationId ? { correlation_id: this.#correlationId } : {}),
      ...(this.#locale ? { locale: this.#locale } : {}),
    };
  }

  /** Записать событие в журнал исполнения (форма `workflow_execution_logs`). */
  appendJournal(event, { nodeId = null, data = {} } = {}) {
    this.#seq += 1;
    const entry = {
      id: deterministicUuid([this.#instanceId, this.#seq]),
      organization_id: this.#organizationId,
      instance_id: this.#instanceId,
      node_id: nodeId,
      event,
      data: data ?? {},
      created_at: this.#now(),
    };
    this.#journal.push(entry);
    return entry;
  }

  get journal() {
    return this.#journal;
  }
}

function accessPath(object, path) {
  if (!Array.isArray(path) || path.length === 0) {
    return clone(object ?? null);
  }
  let current = object;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof segment === "number") {
      current = Array.isArray(current) && segment >= 0 && segment < current.length
        ? current[segment]
        : null;
      continue;
    }
    if (typeof segment !== "string" || DANGEROUS_KEYS.has(segment)) {
      return null;
    }
    current = isRecord(current) && Object.hasOwn(current, segment) ? current[segment] : null;
  }
  return clone(current ?? null);
}

function clone(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return structuredClone(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
