import { BadRequestException } from "@nestjs/common";

export interface WorkflowSchemaIssue {
  message: string;
  path: string;
}

export interface WorkflowSchemaValidationResult {
  errors: WorkflowSchemaIssue[];
  valid: boolean;
}

export interface WorkflowSchemaValidationOptions {
  limits?: Partial<TransformLimits>;
}

interface TransformLimits {
  maxArrayLength: number;
  maxAstDepth: number;
  maxAstNodes: number;
  maxResultBytes: number;
  maxSteps: number;
  maxStringLength: number;
}

interface TransformOperationSpec {
  maxArgs: number;
  minArgs: number;
}

interface TransformValidationContext {
  count: number;
  errors: WorkflowSchemaIssue[];
  limits: TransformLimits;
}

interface NodeValidationContext {
  errors: WorkflowSchemaIssue[];
  limits: TransformLimits;
  path: string;
}

type NodeValidator = (config: unknown, context: NodeValidationContext) => void;

const WORKFLOW_SCHEMA_VERSION = "1.0.0";
const FBP_NODE_TYPES = new Set([
  "backend-api",
  "llm",
  "knowledge-base-search",
  "branch",
  "transform",
  "sub_schema",
  "wait-event",
]);
const FBP_BACKEND_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const FBP_INPUT_SOURCE_KINDS = new Set(["params", "node", "const"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_BACKEND_API_CONFIG_KEYS = new Set([
  "actor_user_id",
  "context",
  "organizationId",
  "organization_id",
]);
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

const TRANSFORM_DEFAULT_LIMITS: TransformLimits = Object.freeze({
  maxArrayLength: 100000,
  maxAstDepth: 64,
  maxAstNodes: 2000,
  maxResultBytes: 262144,
  maxSteps: 100000,
  maxStringLength: 65536,
});

const TRANSFORM_FUNCTION_OPERATIONS: Record<string, TransformOperationSpec> = Object.freeze({
  abs: { minArgs: 1, maxArgs: 1 },
  add: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  and: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  array_concat: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  array_includes: { minArgs: 2, maxArgs: 2 },
  ceil: { minArgs: 1, maxArgs: 1 },
  coalesce: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  concat: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  date_add_days: { minArgs: 2, maxArgs: 2 },
  date_diff_days: { minArgs: 2, maxArgs: 2 },
  date_parse_iso: { minArgs: 1, maxArgs: 1 },
  date_to_iso: { minArgs: 1, maxArgs: 1 },
  div: { minArgs: 2, maxArgs: 2 },
  ends_with: { minArgs: 2, maxArgs: 2 },
  entries: { minArgs: 1, maxArgs: 1 },
  eq: { minArgs: 2, maxArgs: 2 },
  first: { minArgs: 1, maxArgs: 1 },
  flatten: { minArgs: 1, maxArgs: 1 },
  floor: { minArgs: 1, maxArgs: 1 },
  from_entries: { minArgs: 1, maxArgs: 1 },
  gt: { minArgs: 2, maxArgs: 2 },
  gte: { minArgs: 2, maxArgs: 2 },
  has: { minArgs: 2, maxArgs: 2 },
  is_array: { minArgs: 1, maxArgs: 1 },
  is_boolean: { minArgs: 1, maxArgs: 1 },
  is_null: { minArgs: 1, maxArgs: 1 },
  is_number: { minArgs: 1, maxArgs: 1 },
  is_object: { minArgs: 1, maxArgs: 1 },
  is_string: { minArgs: 1, maxArgs: 1 },
  join: { minArgs: 2, maxArgs: 2 },
  keys: { minArgs: 1, maxArgs: 1 },
  last: { minArgs: 1, maxArgs: 1 },
  length: { minArgs: 1, maxArgs: 1 },
  lower: { minArgs: 1, maxArgs: 1 },
  lt: { minArgs: 2, maxArgs: 2 },
  lte: { minArgs: 2, maxArgs: 2 },
  max: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  merge: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  min: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  mod: { minArgs: 2, maxArgs: 2 },
  mul: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  ne: { minArgs: 2, maxArgs: 2 },
  neg: { minArgs: 1, maxArgs: 1 },
  not: { minArgs: 1, maxArgs: 1 },
  omit: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  or: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER },
  pick: { minArgs: 2, maxArgs: Number.MAX_SAFE_INTEGER },
  pow: { minArgs: 2, maxArgs: 2 },
  replace: { minArgs: 3, maxArgs: 3 },
  reverse: { minArgs: 1, maxArgs: 1 },
  round: { minArgs: 1, maxArgs: 1 },
  slice: { minArgs: 3, maxArgs: 3 },
  split: { minArgs: 2, maxArgs: 2 },
  starts_with: { minArgs: 2, maxArgs: 2 },
  str_includes: { minArgs: 2, maxArgs: 2 },
  sub: { minArgs: 2, maxArgs: 2 },
  substring: { minArgs: 3, maxArgs: 3 },
  to_number: { minArgs: 1, maxArgs: 1 },
  to_string: { minArgs: 1, maxArgs: 1 },
  trim: { minArgs: 1, maxArgs: 1 },
  unique: { minArgs: 1, maxArgs: 1 },
  upper: { minArgs: 1, maxArgs: 1 },
  values: { minArgs: 1, maxArgs: 1 },
});

const NODE_VALIDATORS: Record<string, NodeValidator> = Object.freeze({
  "backend-api": validateBackendApiConfig,
  branch: validateBranchConfig,
  "knowledge-base-search": validateKnowledgeBaseSearchConfig,
  llm: validateLlmConfig,
  sub_schema: validateSubSchemaConfig,
  transform: validateTransformConfig,
  "wait-event": validateWaitEventConfig,
});

export function validateWorkflowSchema(
  schema: unknown,
  options: WorkflowSchemaValidationOptions = {},
): WorkflowSchemaValidationResult {
  const limits = resolveLimits(options.limits);
  const errors: WorkflowSchemaIssue[] = [];

  if (!isRecord(schema)) {
    return {
      errors: [{ path: "$", message: "Схема должна быть JSON-объектом." }],
      valid: false,
    };
  }

  if (schema.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push({
      path: "$.schema_version",
      message: `schema_version должен быть "${WORKFLOW_SCHEMA_VERSION}".`,
    });
  }

  if (!Array.isArray(schema.nodes) || schema.nodes.length === 0) {
    errors.push({ path: "$.nodes", message: "nodes должен быть непустым массивом узлов." });
    return { errors, valid: false };
  }

  const nodeIds = collectNodeIds(schema.nodes, errors);
  schema.nodes.forEach((node, index) => {
    validateNode(node, index, nodeIds, errors, limits);
  });

  validateEntry(schema.entry, nodeIds, errors);
  validateConnections(schema.connections, nodeIds, errors);
  validateAcyclic(schema, errors);

  return { errors, valid: errors.length === 0 };
}

export function createWorkflowSchemaValidationException(
  errors: WorkflowSchemaIssue[],
): BadRequestException {
  return new BadRequestException({
    code: "WORKFLOW_SCHEMA_INVALID",
    description: "Workflow schema failed validation before version creation.",
    errors,
    humanMessage: "Схема Workflow не прошла валидацию.",
  });
}

export function collectWorkflowSubSchemaSlugs(schema: unknown): string[] {
  const slugs = new Set<string>();
  collectSubSchemaSlugsFromSchema(schema, slugs);
  return [...slugs].sort();
}

function resolveLimits(limits: Partial<TransformLimits> | undefined): TransformLimits {
  return { ...TRANSFORM_DEFAULT_LIMITS, ...(limits ?? {}) };
}

function collectNodeIds(nodes: unknown[], errors: WorkflowSchemaIssue[]): Set<string> {
  const ids = new Set<string>();
  nodes.forEach((node, index) => {
    const id = isRecord(node) ? node.id : undefined;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push({
        path: `$.nodes[${index}].id`,
        message: "id узла должен быть непустой строкой.",
      });
      return;
    }
    if (ids.has(id)) {
      errors.push({
        path: `$.nodes[${index}].id`,
        message: `Дублирующийся id узла "${id}".`,
      });
      return;
    }
    ids.add(id);
  });
  return ids;
}

function validateNode(
  node: unknown,
  index: number,
  nodeIds: Set<string>,
  errors: WorkflowSchemaIssue[],
  limits: TransformLimits,
): void {
  const path = `$.nodes[${index}]`;
  if (!isRecord(node)) {
    errors.push({ path, message: "Узел должен быть объектом." });
    return;
  }

  if (typeof node.type !== "string" || !FBP_NODE_TYPES.has(node.type)) {
    errors.push({ path: `${path}.type`, message: `Неизвестный тип узла "${node.type}".` });
  } else {
    NODE_VALIDATORS[node.type](node.config ?? {}, { errors, limits, path: `${path}.config` });
  }

  if (node.input !== undefined) {
    validateInputSpec(node.input, `${path}.input`, node.id, nodeIds, errors);
  }
}

function validateInputSpec(
  inputSpec: unknown,
  path: string,
  selfId: unknown,
  nodeIds: Set<string>,
  errors: WorkflowSchemaIssue[],
): void {
  if (!isRecord(inputSpec)) {
    errors.push({ path, message: "input должен быть объектом отображения порт -> источник." });
    return;
  }

  for (const [key, source] of Object.entries(inputSpec)) {
    const sourcePath = `${path}.${key}`;
    if (DANGEROUS_KEYS.has(key)) {
      errors.push({ path: sourcePath, message: `Ключ входа "${key}" запрещён.` });
      continue;
    }
    if (!isRecord(source) || typeof source.kind !== "string" || !FBP_INPUT_SOURCE_KINDS.has(source.kind)) {
      errors.push({
        path: `${sourcePath}.kind`,
        message: `Источник входа должен иметь kind из ${[...FBP_INPUT_SOURCE_KINDS].join(", ")}.`,
      });
      continue;
    }
    if (source.kind === "node") {
      if (source.node === selfId) {
        errors.push({
          path: `${sourcePath}.node`,
          message: "Узел не может ссылаться на собственный результат.",
        });
      } else if (typeof source.node !== "string" || !nodeIds.has(source.node)) {
        errors.push({
          path: `${sourcePath}.node`,
          message: `Ссылка на несуществующий узел "${String(source.node)}".`,
        });
      }
    }
    if (source.kind !== "const" && source.path !== undefined) {
      validatePathSegments(source.path, `${sourcePath}.path`, errors);
    }
  }
}

function validatePathSegments(
  segments: unknown,
  path: string,
  errors: WorkflowSchemaIssue[],
): void {
  if (!Array.isArray(segments)) {
    errors.push({ path, message: "path должен быть массивом сегментов." });
    return;
  }

  segments.forEach((segment, index) => {
    const segmentPath = `${path}[${index}]`;
    if (typeof segment === "number") {
      if (!Number.isSafeInteger(segment) || segment < 0) {
        errors.push({ path: segmentPath, message: "Числовой сегмент должен быть неотрицательным целым." });
      }
      return;
    }
    if (typeof segment === "string") {
      if (DANGEROUS_KEYS.has(segment)) {
        errors.push({ path: segmentPath, message: `Сегмент "${segment}" запрещён.` });
      }
      return;
    }
    errors.push({
      path: segmentPath,
      message: "Сегмент пути должен быть строкой или неотрицательным целым.",
    });
  });
}

function validateEntry(entry: unknown, nodeIds: Set<string>, errors: WorkflowSchemaIssue[]): void {
  if (typeof entry !== "string" || entry.trim() === "") {
    errors.push({
      path: "$.entry",
      message: "entry должен быть непустой строкой (id стартового узла).",
    });
    return;
  }
  if (!nodeIds.has(entry)) {
    errors.push({ path: "$.entry", message: `entry ссылается на несуществующий узел "${entry}".` });
  }
}

function validateConnections(
  connections: unknown,
  nodeIds: Set<string>,
  errors: WorkflowSchemaIssue[],
): void {
  if (connections === undefined) {
    return;
  }
  if (!Array.isArray(connections)) {
    errors.push({ path: "$.connections", message: "connections должен быть массивом соединений." });
    return;
  }

  const seen = new Set<string>();
  connections.forEach((connection, index) => {
    const path = `$.connections[${index}]`;
    if (!isRecord(connection)) {
      errors.push({ path, message: "Соединение должно быть объектом." });
      return;
    }
    if (typeof connection.from !== "string" || !nodeIds.has(connection.from)) {
      errors.push({
        path: `${path}.from`,
        message: `Соединение исходит из несуществующего узла "${String(connection.from)}".`,
      });
    }
    if (typeof connection.to !== "string" || !nodeIds.has(connection.to)) {
      errors.push({
        path: `${path}.to`,
        message: `Соединение ведёт в несуществующий узел "${String(connection.to)}".`,
      });
    }
    const port = connection.port ?? "out";
    if (typeof port !== "string" || port.trim() === "") {
      errors.push({ path: `${path}.port`, message: "port должен быть непустой строкой." });
      return;
    }
    const key = `${String(connection.from)}\u001f${port}`;
    if (seen.has(key)) {
      errors.push({
        path: `${path}.port`,
        message: `Дублирующийся выходной порт "${port}" узла "${String(connection.from)}".`,
      });
    }
    seen.add(key);
  });
}

function validateAcyclic(schema: Record<string, unknown>, errors: WorkflowSchemaIssue[]): void {
  const cycle = findCycle(schema);
  if (cycle) {
    errors.push({
      path: "$.connections",
      message: `Граф должен быть ациклическим (DAG). Обнаружен цикл: ${cycle.join(" -> ")}.`,
    });
  }
}

function validateBackendApiConfig(config: unknown, { errors, limits, path }: NodeValidationContext): void {
  if (!isRecord(config)) {
    errors.push({ path, message: "Узел backend-api требует объект config." });
    return;
  }

  for (const key of Object.keys(config)) {
    if (FORBIDDEN_BACKEND_API_CONFIG_KEYS.has(key)) {
      errors.push({
        path: `${path}.${key}`,
        message: "Узел не может задавать арендатора/актора/контекст - они берутся из контекста экземпляра (§13.13-п.4).",
      });
    }
  }

  if (typeof config.method !== "string" || !FBP_BACKEND_API_METHODS.has(config.method)) {
    errors.push({
      path: `${path}.method`,
      message: `method должен быть одним из ${[...FBP_BACKEND_API_METHODS].join(", ")}.`,
    });
  }

  validateApiPath(config.path, `${path}.path`, errors, { required: true });
  if (config.body !== undefined) {
    pushTransformErrors(config.body, `${path}.body`, errors, limits);
  }
  if (config.query !== undefined) {
    pushTransformErrors(config.query, `${path}.query`, errors, limits);
  }
  if (config.timeout_ms !== undefined) {
    validateTimeout(config.timeout_ms, `${path}.timeout_ms`, errors, { max: 30000 });
  }
}

function validateBranchConfig(config: unknown, { errors, limits, path }: NodeValidationContext): void {
  if (!isRecord(config) || config.condition === undefined) {
    errors.push({ path: `${path}.condition`, message: "Узел branch требует поле condition." });
    return;
  }
  pushTransformErrors(config.condition, `${path}.condition`, errors, limits);
}

function validateTransformConfig(config: unknown, { errors, limits, path }: NodeValidationContext): void {
  if (!isRecord(config) || config.expression === undefined) {
    errors.push({ path: `${path}.expression`, message: "Узел transform требует поле expression." });
    return;
  }
  pushTransformErrors(config.expression, `${path}.expression`, errors, limits);
}

function validateSubSchemaConfig(config: unknown, { errors, path }: NodeValidationContext): void {
  if (!isRecord(config)) {
    errors.push({ path, message: "Узел sub_schema требует объект config." });
    return;
  }
  if (config.bodyGraph !== undefined) {
    errors.push({
      path: `${path}.bodyGraph`,
      message: "Узел sub_schema хранит только ссылку subSchemaSlug; embedded bodyGraph запрещён.",
    });
  }
  if (typeof config.subSchemaSlug !== "string" || config.subSchemaSlug.trim() === "") {
    errors.push({ path: `${path}.subSchemaSlug`, message: "Узел sub_schema требует непустой subSchemaSlug." });
  }
}

function validateLlmConfig(config: unknown, { errors, limits, path }: NodeValidationContext): void {
  if (!isRecord(config) || config.prompt === undefined) {
    errors.push({
      path: `${path}.prompt`,
      message: "Узел llm требует поле prompt (Transform-выражение).",
    });
    return;
  }
  validateApiPath(config.path, `${path}.path`, errors, { required: false });
  pushTransformErrors(config.prompt, `${path}.prompt`, errors, limits);
  if (config.params !== undefined) {
    pushTransformErrors(config.params, `${path}.params`, errors, limits);
  }
}

function validateKnowledgeBaseSearchConfig(
  config: unknown,
  { errors, limits, path }: NodeValidationContext,
): void {
  if (!isRecord(config) || config.query === undefined) {
    errors.push({
      path: `${path}.query`,
      message: "Узел knowledge-base-search требует поле query (Transform-выражение).",
    });
    return;
  }
  validateApiPath(config.path, `${path}.path`, errors, { required: false });
  pushTransformErrors(config.query, `${path}.query`, errors, limits);
  if (config.top_k !== undefined) {
    const topK = config.top_k;
    if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 100) {
      errors.push({ path: `${path}.top_k`, message: "top_k должен быть целым числом от 1 до 100." });
    }
  }
}

function validateWaitEventConfig(config: unknown, { errors, limits, path }: NodeValidationContext): void {
  if (!isRecord(config) || typeof config.event_type !== "string" || config.event_type.trim() === "") {
    errors.push({ path: `${path}.event_type`, message: "Узел wait-event требует непустой event_type." });
    return;
  }
  if (config.correlation !== undefined) {
    pushTransformErrors(config.correlation, `${path}.correlation`, errors, limits);
  }
  if (config.timeout_ms !== undefined) {
    validateTimeout(config.timeout_ms, `${path}.timeout_ms`, errors, {});
  }
}

function collectSubSchemaSlugsFromSchema(schema: unknown, slugs: Set<string>): void {
  if (!isRecord(schema) || !Array.isArray(schema.nodes)) {
    return;
  }

  for (const node of schema.nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const config = isRecord(node.config) ? node.config : {};
    if (node.type === "sub_schema" && typeof config.subSchemaSlug === "string" && config.subSchemaSlug.trim() !== "") {
      slugs.add(config.subSchemaSlug.trim());
    }
    if (isRecord(config.bodyGraph)) {
      collectSubSchemaSlugsFromSchema(config.bodyGraph, slugs);
    }
  }
}

function validateApiPath(
  value: unknown,
  path: string,
  errors: WorkflowSchemaIssue[],
  { required }: { required: boolean },
): void {
  if (value === undefined && !required) {
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "path должен быть непустой строкой." });
    return;
  }
  if (value !== "/api/v1" && !value.startsWith("/api/v1/")) {
    errors.push({ path, message: "path должен указывать на публичный Backend API под /api/v1." });
  }
  const placeholders = value.match(PLACEHOLDER);
  if (placeholders) {
    for (const raw of placeholders) {
      if (raw.slice(1, -1) === "") {
        errors.push({ path, message: "Пустой плейсхолдер {} в path недопустим." });
      }
    }
  }
}

function validateTimeout(
  value: unknown,
  path: string,
  errors: WorkflowSchemaIssue[],
  { max }: { max?: number },
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    (max !== undefined && value > max)
  ) {
    errors.push({
      path,
      message: max === undefined
        ? "timeout_ms должен быть положительным целым числом."
        : `timeout_ms должен быть целым числом от 1 до ${max}.`,
    });
  }
}

function pushTransformErrors(
  expression: unknown,
  path: string,
  errors: WorkflowSchemaIssue[],
  limits: TransformLimits,
): void {
  const result = validateTransformExpression(expression, limits);
  for (const error of result.errors) {
    errors.push({ path: `${path}${normalizeTransformPath(error.path)}`, message: error.message });
  }
}

function normalizeTransformPath(path: string): string {
  return path.startsWith("$") ? path.slice(1) : `.${path}`;
}

function validateTransformExpression(
  expression: unknown,
  limits: TransformLimits,
  boundVars: Iterable<string> = [],
): WorkflowSchemaValidationResult {
  const context: TransformValidationContext = { count: 0, errors: [], limits };
  validateTransformNode(expression, "$", 1, new Set(boundVars), context);
  return { errors: context.errors, valid: context.errors.length === 0 };
}

function validateTransformNode(
  node: unknown,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  context.count += 1;
  if (context.count > context.limits.maxAstNodes) {
    pushTransformErrorOnce(context, path, `Выражение превышает лимит узлов AST (${context.limits.maxAstNodes}).`);
    return;
  }
  if (depth > context.limits.maxAstDepth) {
    pushTransformError(context, path, `Выражение превышает лимит глубины AST (${context.limits.maxAstDepth}).`);
    return;
  }
  if (!isRecord(node) || typeof node.op !== "string") {
    pushTransformError(context, path, "Ожидался объект-выражение с полем op.");
    return;
  }

  switch (node.op) {
    case "lit":
      validateLiteral(node, path, context);
      return;
    case "input":
      return;
    case "var":
      validateVar(node, path, boundVars, context);
      return;
    case "get":
      validateGet(node, path, depth, boundVars, context);
      return;
    case "if":
      validateTransformChild(node.cond, `${path}.cond`, depth, boundVars, context);
      validateTransformChild(node.then, `${path}.then`, depth, boundVars, context);
      validateTransformChild(node.else, `${path}.else`, depth, boundVars, context);
      return;
    case "map":
    case "filter":
      validateMapFilter(node, path, depth, boundVars, context);
      return;
    case "reduce":
      validateReduce(node, path, depth, boundVars, context);
      return;
    default:
      validateFunction(node, path, depth, boundVars, context);
  }
}

function validateTransformChild(
  child: unknown,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  if (child === undefined) {
    pushTransformError(context, path, "Обязательное подвыражение отсутствует.");
    return;
  }
  validateTransformNode(child, path, depth + 1, boundVars, context);
}

function validateLiteral(
  node: Record<string, unknown>,
  path: string,
  context: TransformValidationContext,
): void {
  if (!Object.hasOwn(node, "value")) {
    pushTransformError(context, `${path}.value`, "lit требует поле value.");
    return;
  }
  if (!isJsonValue(node.value)) {
    pushTransformError(context, `${path}.value`, "lit.value должно быть JSON-значением без функций/undefined.");
    return;
  }
  if (byteLength(node.value) > context.limits.maxResultBytes) {
    pushTransformError(context, `${path}.value`, "Литерал превышает лимит размера результата.");
  }
}

function validateVar(
  node: Record<string, unknown>,
  path: string,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  if (typeof node.name !== "string" || node.name === "") {
    pushTransformError(context, `${path}.name`, "var.name должно быть непустой строкой.");
    return;
  }
  if (!boundVars.has(node.name)) {
    pushTransformError(
      context,
      `${path}.name`,
      `Переменная "${node.name}" не связана (доступны только переменные map/filter/reduce).`,
    );
  }
}

function validateGet(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  validateTransformChild(node.object, `${path}.object`, depth, boundVars, context);
  if (!Array.isArray(node.path) || node.path.length === 0) {
    pushTransformError(context, `${path}.path`, "get.path должно быть непустым массивом сегментов.");
    return;
  }
  node.path.forEach((segment, index) => {
    const segmentPath = `${path}.path[${index}]`;
    if (typeof segment === "number") {
      if (!Number.isSafeInteger(segment) || segment < 0) {
        pushTransformError(context, segmentPath, "Числовой сегмент должен быть неотрицательным целым.");
      }
      return;
    }
    if (typeof segment === "string") {
      if (DANGEROUS_KEYS.has(segment)) {
        pushTransformError(context, segmentPath, `Сегмент "${segment}" запрещён.`);
      }
      return;
    }
    pushTransformError(context, segmentPath, "Сегмент пути должен быть строкой или неотрицательным целым.");
  });
}

function validateMapFilter(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  validateTransformChild(node.array, `${path}.array`, depth, boundVars, context);
  const alias = validateAlias(node.as, `${path}.as`, context);
  const childVars = alias ? new Set([...boundVars, alias]) : boundVars;
  validateTransformChild(node.body, `${path}.body`, depth, childVars, context);
}

function validateReduce(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  validateTransformChild(node.array, `${path}.array`, depth, boundVars, context);
  validateTransformChild(node.init, `${path}.init`, depth, boundVars, context);
  const alias = validateAlias(node.as, `${path}.as`, context);
  const accumulator = validateAlias(node.acc, `${path}.acc`, context);
  const childVars = new Set(boundVars);
  if (alias) {
    childVars.add(alias);
  }
  if (accumulator) {
    childVars.add(accumulator);
  }
  validateTransformChild(node.body, `${path}.body`, depth, childVars, context);
}

function validateAlias(
  alias: unknown,
  path: string,
  context: TransformValidationContext,
): string | null {
  if (typeof alias !== "string" || alias === "") {
    pushTransformError(context, path, "Псевдоним переменной должен быть непустой строкой.");
    return null;
  }
  if (DANGEROUS_KEYS.has(alias)) {
    pushTransformError(context, path, `Псевдоним "${alias}" запрещён.`);
    return null;
  }
  return alias;
}

function validateFunction(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  boundVars: Set<string>,
  context: TransformValidationContext,
): void {
  if (!Object.hasOwn(TRANSFORM_FUNCTION_OPERATIONS, node.op as string)) {
    pushTransformError(context, `${path}.op`, `Недопустимая операция "${String(node.op)}".`);
    return;
  }
  const spec = TRANSFORM_FUNCTION_OPERATIONS[node.op as string];
  if (!Array.isArray(node.args)) {
    pushTransformError(context, `${path}.args`, `Операция "${String(node.op)}" требует массив args.`);
    return;
  }
  if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
    pushTransformError(
      context,
      `${path}.args`,
      `Операция "${String(node.op)}" ожидает от ${spec.minArgs} до ${spec.maxArgs} аргументов, получено ${node.args.length}.`,
    );
  }
  node.args.forEach((argument, index) => {
    validateTransformNode(argument, `${path}.args[${index}]`, depth + 1, boundVars, context);
  });
}

function pushTransformError(
  context: TransformValidationContext,
  path: string,
  message: string,
): void {
  context.errors.push({ path, message });
}

function pushTransformErrorOnce(
  context: TransformValidationContext,
  path: string,
  message: string,
): void {
  if (!context.errors.some((error) => error.message === message)) {
    pushTransformError(context, path, message);
  }
}

function findCycle(schema: Record<string, unknown>): string[] | null {
  const nodes = Array.isArray(schema.nodes) ? schema.nodes : [];
  const connections = Array.isArray(schema.connections) ? schema.connections : [];
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    if (isRecord(node) && typeof node.id === "string") {
      adjacency.set(node.id, []);
    }
  }
  for (const connection of connections) {
    if (
      isRecord(connection) &&
      typeof connection.from === "string" &&
      typeof connection.to === "string" &&
      adjacency.has(connection.from) &&
      adjacency.has(connection.to)
    ) {
      adjacency.get(connection.from)?.push(connection.to);
    }
  }

  const white = 0;
  const grey = 1;
  const black = 2;
  const color = new Map([...adjacency.keys()].map((id) => [id, white]));
  const stack: string[] = [];

  function visit(nodeId: string): string[] | null {
    color.set(nodeId, grey);
    stack.push(nodeId);

    for (const next of adjacency.get(nodeId) ?? []) {
      const state = color.get(next);
      if (state === grey) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (state === white) {
        const cycle = visit(next);
        if (cycle) {
          return cycle;
        }
      }
    }

    stack.pop();
    color.set(nodeId, black);
    return null;
  }

  for (const nodeId of adjacency.keys()) {
    if (color.get(nodeId) === white) {
      const cycle = visit(nodeId);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
