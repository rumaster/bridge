import {
  TRANSFORM_DEFAULT_LIMITS,
  TRANSFORM_FUNCTION_OPERATIONS,
} from "../../../../packages/contracts/src/c5.js";
import { TransformValidationError } from "./errors.js";

/**
 * Валидация выражения Transform Node НА ЭТАПЕ СОХРАНЕНИЯ СХЕМЫ (ТЗ §13.4): любая
 * операция вне whitelist, некорректная форма AST, несвязанная переменная или
 * превышение лимитов AST отвергаются до сохранения — не во время исполнения.
 *
 * Возвращает `{ valid, errors: [{ path, message }] }`.
 */
export function validateTransformExpression(expression, options = {}) {
  const limits = { ...TRANSFORM_DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const context = { errors: [], count: 0, limits };
  const boundVars = new Set(options.boundVars ?? []);

  validateNode(expression, "$", 1, boundVars, context);

  return { valid: context.errors.length === 0, errors: context.errors };
}

export function assertTransformExpression(expression, options = {}) {
  const result = validateTransformExpression(expression, options);
  if (!result.valid) {
    throw new TransformValidationError(result.errors);
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function validateNode(node, path, depth, boundVars, context) {
  context.count += 1;
  if (context.count > context.limits.maxAstNodes) {
    pushOnce(context, path, `Выражение превышает лимит узлов AST (${context.limits.maxAstNodes}).`);
    return;
  }
  if (depth > context.limits.maxAstDepth) {
    push(context, path, `Выражение превышает лимит глубины AST (${context.limits.maxAstDepth}).`);
    return;
  }
  if (!isRecord(node) || typeof node.op !== "string") {
    push(context, path, "Ожидался объект-выражение с полем op.");
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
      validateChild(node.cond, `${path}.cond`, depth, boundVars, context);
      validateChild(node.then, `${path}.then`, depth, boundVars, context);
      validateChild(node.else, `${path}.else`, depth, boundVars, context);
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

function validateChild(child, path, depth, boundVars, context) {
  if (child === undefined) {
    push(context, path, "Обязательное подвыражение отсутствует.");
    return;
  }
  validateNode(child, path, depth + 1, boundVars, context);
}

function validateLiteral(node, path, context) {
  if (!Object.hasOwn(node, "value")) {
    push(context, `${path}.value`, "lit требует поле value.");
    return;
  }
  if (!isJsonValue(node.value)) {
    push(context, `${path}.value`, "lit.value должно быть JSON-значением без функций/undefined.");
    return;
  }
  if (byteLength(node.value) > context.limits.maxResultBytes) {
    push(context, `${path}.value`, "Литерал превышает лимит размера результата.");
  }
}

function validateVar(node, path, boundVars, context) {
  if (typeof node.name !== "string" || node.name === "") {
    push(context, `${path}.name`, "var.name должно быть непустой строкой.");
    return;
  }
  if (!boundVars.has(node.name)) {
    push(
      context,
      `${path}.name`,
      `Переменная "${node.name}" не связана (доступны только переменные map/filter/reduce).`,
    );
  }
}

function validateGet(node, path, depth, boundVars, context) {
  validateChild(node.object, `${path}.object`, depth, boundVars, context);
  if (!Array.isArray(node.path) || node.path.length === 0) {
    push(context, `${path}.path`, "get.path должно быть непустым массивом сегментов.");
    return;
  }
  node.path.forEach((segment, index) => {
    const segmentPath = `${path}.path[${index}]`;
    if (typeof segment === "number") {
      if (!Number.isSafeInteger(segment) || segment < 0) {
        push(context, segmentPath, "Числовой сегмент должен быть неотрицательным целым.");
      }
      return;
    }
    if (typeof segment === "string") {
      if (DANGEROUS_KEYS.has(segment)) {
        push(context, segmentPath, `Сегмент "${segment}" запрещён.`);
      }
      return;
    }
    push(context, segmentPath, "Сегмент пути должен быть строкой или неотрицательным целым.");
  });
}

function validateMapFilter(node, path, depth, boundVars, context) {
  validateChild(node.array, `${path}.array`, depth, boundVars, context);
  const alias = validateAlias(node.as, `${path}.as`, context);
  const childVars = alias ? new Set([...boundVars, alias]) : boundVars;
  validateChild(node.body, `${path}.body`, depth, childVars, context);
}

function validateReduce(node, path, depth, boundVars, context) {
  validateChild(node.array, `${path}.array`, depth, boundVars, context);
  validateChild(node.init, `${path}.init`, depth, boundVars, context);
  const alias = validateAlias(node.as, `${path}.as`, context);
  const accumulator = validateAlias(node.acc, `${path}.acc`, context);
  const childVars = new Set(boundVars);
  if (alias) {
    childVars.add(alias);
  }
  if (accumulator) {
    childVars.add(accumulator);
  }
  validateChild(node.body, `${path}.body`, depth, childVars, context);
}

function validateAlias(alias, path, context) {
  if (typeof alias !== "string" || alias === "") {
    push(context, path, "Псевдоним переменной должен быть непустой строкой.");
    return null;
  }
  if (DANGEROUS_KEYS.has(alias)) {
    push(context, path, `Псевдоним "${alias}" запрещён.`);
    return null;
  }
  return alias;
}

function validateFunction(node, path, depth, boundVars, context) {
  // ВАЖНО: только СОБСТВЕННЫЕ ключи таблицы — иначе унаследованные от
  // Object.prototype имена (`constructor`, `toString`, `hasOwnProperty`, …)
  // прошли бы как «операции» и стали лазейкой из песочницы (§13.4).
  if (!Object.hasOwn(TRANSFORM_FUNCTION_OPERATIONS, node.op)) {
    push(context, `${path}.op`, `Недопустимая операция "${node.op}".`);
    return;
  }
  const spec = TRANSFORM_FUNCTION_OPERATIONS[node.op];
  if (!Array.isArray(node.args)) {
    push(context, `${path}.args`, `Операция "${node.op}" требует массив args.`);
    return;
  }
  if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
    push(
      context,
      `${path}.args`,
      `Операция "${node.op}" ожидает от ${spec.minArgs} до ${spec.maxArgs} аргументов, получено ${node.args.length}.`,
    );
  }
  node.args.forEach((argument, index) => {
    validateNode(argument, `${path}.args[${index}]`, depth + 1, boundVars, context);
  });
}

function push(context, path, message) {
  context.errors.push({ path, message });
}

function pushOnce(context, path, message) {
  if (!context.errors.some((error) => error.message === message)) {
    push(context, path, message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value) {
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

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
