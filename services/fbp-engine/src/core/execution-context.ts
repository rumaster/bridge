import { deterministicUuid } from "./ids.js";
import { WorkflowExecutionError } from "./errors.js";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Опции конструктора {@link ExecutionContext}. */
export interface ExecutionContextOptions {
  organizationId?: string;
  actorUserId?: string | null;
  trigger?: string | null;
  roles?: string[];
  correlationId?: string | null;
  locale?: string | null;
  instanceId?: string;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  input?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  variables?: Record<string, unknown> | null;
  resolveSubSchema?: ResolveSubSchemaCallback | null;
  resolvedSubSchemas?: Record<string, unknown> | null;
  seq?: number;
  now?: () => string;
  /** Монотонные часы для длительностей в трассе (инъекция ради тестов). */
  monotonic?: () => number;
}

export type ResolveSubSchemaCallback = (args: {
  organizationId: string;
  slug: string;
}) => Promise<unknown> | unknown;

/** Опции восстановления контекста из снимка. */
export interface ExecutionContextSnapshotOptions {
  now?: () => string;
}

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
  #variables = new Map();
  #journal = [];
  #resolveSubSchema;
  #resolvedSubSchemas;
  #now;
  #monotonic;
  #startedAt;
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
    outputs = null,
    variables = null,
    resolveSubSchema = null,
    resolvedSubSchemas = null,
    seq = 0,
    now = () => new Date().toISOString(),
    monotonic = () => performance.now(),
  }: ExecutionContextOptions) {
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
    this.#resolveSubSchema = typeof resolveSubSchema === "function" ? resolveSubSchema : null;
    this.#resolvedSubSchemas = isRecord(resolvedSubSchemas) ? clone(resolvedSubSchemas) : {};
    this.#now = now;
    this.#monotonic = monotonic;
    this.#startedAt = monotonic();
    if (isRecord(variables)) {
      for (const [name, value] of Object.entries(variables)) {
        if (!DANGEROUS_KEYS.has(name)) this.#variables.set(name, clone(value));
      }
    }
    // Восстановление результатов ранее исполненных узлов из внешнего состояния
    // (stateless executor, ТЗ §25.3): любой узел-исполнитель поднимает контекст
    // из `workflow_instance_state`, не полагаясь на память между шагами.
    if (isRecord(outputs)) {
      for (const [nodeId, value] of Object.entries(outputs)) {
        if (!DANGEROUS_KEYS.has(nodeId)) {
          this.#outputs.set(nodeId, clone(value));
        }
      }
    }
    this.#seq = Number.isInteger(seq) && seq >= 0 ? seq : 0;
  }

  /**
   * Восстановить контекст экземпляра из внешнего состояния (ТЗ §25.3). Снимок
   * (`snapshot()`) хранится в `workflow_instance_state` через Backend; любой
   * узел-исполнитель может поднять по нему контекст и продолжить экземпляр —
   * исполнитель не держит состояние между шагами.
   */
  static fromSnapshot(snapshot, { now }: ExecutionContextSnapshotOptions = {}) {
    if (!isRecord(snapshot)) {
      throw new WorkflowExecutionError(
        "invalid_instance_state",
        "Снимок состояния экземпляра должен быть объектом (workflow_instance_state).",
      );
    }
    return new ExecutionContext({
      organizationId: snapshot.organization_id,
      actorUserId: snapshot.actor_user_id ?? null,
      trigger: snapshot.trigger ?? null,
      roles: snapshot.roles ?? [],
      correlationId: snapshot.correlation_id ?? null,
      locale: snapshot.locale ?? null,
      instanceId: snapshot.instance_id,
      workflowId: snapshot.workflow_id ?? null,
      workflowVersionId: snapshot.workflow_version_id ?? null,
      input: snapshot.input ?? {},
      outputs: snapshot.outputs ?? null,
      variables: snapshot.variables ?? null,
      resolvedSubSchemas: snapshot.resolved_subschemas ?? null,
      seq: snapshot.seq ?? 0,
      ...(now ? { now } : {}),
    });
  }

  /**
   * Снимок состояния экземпляра для внешнего хранения (`workflow_instance_state`,
   * ТЗ §25.3). Содержит ВСЁ, что нужно другому узлу-исполнителю, чтобы продолжить
   * экземпляр: арендатор/актор/триггер, входные параметры, результаты уже
   * исполненных узлов и порядковый счётчик журнала. Журнал сюда НЕ входит — он
   * копится в `workflow_execution_logs` и сохраняется Backend отдельно.
   */
  snapshot() {
    const outputs: Record<string, any> = {};
    for (const [nodeId, value] of this.#outputs) {
      outputs[nodeId] = clone(value);
    }
    const variables: Record<string, any> = {};
    for (const [name, value] of this.#variables) {
      variables[name] = clone(value);
    }
    return {
      variables,
      organization_id: this.#organizationId,
      actor_user_id: this.#actorUserId,
      trigger: this.#trigger,
      roles: [...this.#roles],
      ...(this.#correlationId ? { correlation_id: this.#correlationId } : {}),
      ...(this.#locale ? { locale: this.#locale } : {}),
      instance_id: this.#instanceId,
      workflow_id: this.#workflowId,
      workflow_version_id: this.#workflowVersionId,
      input: clone(this.#params),
      outputs,
      resolved_subschemas: clone(this.#resolvedSubSchemas),
      seq: this.#seq,
    };
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

  /**
   * Контекст субсхемы. Переменные родителя НЕ передаются: субсхема общается с
   * вызывающим графом только через граничные порты start/end — иначе она молча
   * зависела бы от переменных вызывающего и перестала быть переиспользуемой.
   */
  createChild({ input = {} } = {}) {
    return new ExecutionContext({
      monotonic: this.#monotonic,
      organizationId: this.#organizationId,
      actorUserId: this.#actorUserId,
      trigger: this.#trigger,
      roles: [...this.#roles],
      correlationId: this.#correlationId,
      locale: this.#locale,
      instanceId: this.#instanceId,
      workflowId: this.#workflowId,
      workflowVersionId: this.#workflowVersionId,
      input,
      resolveSubSchema: this.#resolveSubSchema,
      resolvedSubSchemas: this.#resolvedSubSchemas,
      now: this.#now,
    });
  }

  async resolveSubSchema(slug) {
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new WorkflowExecutionError("invalid_subschema_ref", "Ссылка на субсхему должна быть непустой строкой.");
    }

    const normalized = slug.trim();
    if (this.#resolveSubSchema) {
      const schema = await this.#resolveSubSchema({ organizationId: this.#organizationId, slug: normalized });
      return clone(schema);
    }

    if (Object.hasOwn(this.#resolvedSubSchemas, normalized)) {
      return clone(this.#resolvedSubSchemas[normalized]);
    }

    throw new WorkflowExecutionError(
      "subschema_not_found",
      `Субсхема "${normalized}" не найдена в runtime registry.`,
      { nodeType: "sub_schema" },
    );
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
   * Ревизия 2026-07-15: `assembleInput`/`resolveSource` удалены вместе с
   * декларативной «проводкой» (`{ kind: "params"|"node"|"const" }`). Вход узла
   * теперь собирает исполнитель по входящим data-связям графа. Изоляция §13.4
   * сохранена: узел по-прежнему видит ТОЛЬКО собранный `input`, а не контекст.
   */

  /** Переменные экземпляра для узлов variable_read / variable_write. */
  getVariable(name) {
    if (typeof name !== "string" || DANGEROUS_KEYS.has(name)) return null;
    return this.#variables.has(name) ? clone(this.#variables.get(name)) : null;
  }

  setVariable(name, value) {
    if (typeof name !== "string" || name.trim() === "" || DANGEROUS_KEYS.has(name)) {
      throw new WorkflowExecutionError("invalid_variable_name", `Недопустимое имя переменной "${String(name)}".`);
    }
    this.#variables.set(name, clone(value));
  }

  /** Монотонное время от старта контекста — для длительностей в трассе. */
  elapsedMs() {
    return Math.round(this.#monotonic() - this.#startedAt);
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
