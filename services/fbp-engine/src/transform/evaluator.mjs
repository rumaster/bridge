import {
  TRANSFORM_DEFAULT_LIMITS,
  TRANSFORM_FUNCTION_OPERATIONS,
} from "../../../../packages/contracts/src/c5.mjs";
import { TransformEvaluationError } from "./errors.mjs";
import { OPERATIONS, isPlainObject } from "./operations.mjs";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Безопасный вычислитель Transform Node (ТЗ §13.4). Исполняет валидированное
 * декларативное выражение (AST в JSON), видя ТОЛЬКО свой вход `input` и
 * лексические переменные map/filter/reduce. Изоляция «по построению»: у
 * грамматики нет операций доступа к среде/сети/ФС/секретам/времени/ГСЧ/коду.
 *
 * Ограничения ресурсов (детерминированы): бюджет шагов ограничивает время,
 * поскольку грамматика не допускает неограниченных циклов; отдельно ограничены
 * длины строк/массивов и размер результата.
 */
export function evaluateTransform(expression, input, limits = {}) {
  const state = {
    steps: 0,
    limits: { ...TRANSFORM_DEFAULT_LIMITS, ...limits },
  };
  const guards = createGuards(state);
  const rootScope = Object.freeze(Object.create(null));

  const value = evaluateNode(expression, input ?? {}, rootScope, state, guards);
  guards.checkResultSize(value);
  return value;
}

function createGuards(state) {
  return {
    checkString(value) {
      if (typeof value === "string" && value.length > state.limits.maxStringLength) {
        throw new TransformEvaluationError(
          "string_too_long",
          `Результат-строка превышает лимит ${state.limits.maxStringLength}.`,
        );
      }
      return value;
    },
    checkArray(value) {
      if (Array.isArray(value) && value.length > state.limits.maxArrayLength) {
        throw new TransformEvaluationError(
          "array_too_long",
          `Результат-массив превышает лимит ${state.limits.maxArrayLength}.`,
        );
      }
      return value;
    },
    checkResultSize(value) {
      const bytes = byteLength(value);
      if (bytes > state.limits.maxResultBytes) {
        throw new TransformEvaluationError(
          "result_too_large",
          `Размер результата (${bytes} байт) превышает лимит ${state.limits.maxResultBytes}.`,
        );
      }
      return value;
    },
  };
}

function evaluateNode(node, input, scope, state, guards) {
  state.steps += 1;
  if (state.steps > state.limits.maxSteps) {
    throw new TransformEvaluationError(
      "step_budget_exceeded",
      `Превышен бюджет шагов вычисления (${state.limits.maxSteps}).`,
    );
  }

  if (!isPlainObject(node) || typeof node.op !== "string") {
    throw new TransformEvaluationError("malformed_expression", "Узел выражения повреждён.");
  }

  switch (node.op) {
    case "lit":
      return cloneLiteral(node.value);
    case "input":
      return input;
    case "var": {
      if (!(node.name in scope)) {
        throw new TransformEvaluationError(
          "unbound_variable",
          `Переменная "${node.name}" не определена.`,
        );
      }
      return scope[node.name];
    }
    case "get": {
      const object = evaluateNode(node.object, input, scope, state, guards);
      return accessPath(object, node.path);
    }
    case "if": {
      const condition = evaluateNode(node.cond, input, scope, state, guards);
      return condition
        ? evaluateNode(node.then, input, scope, state, guards)
        : evaluateNode(node.else, input, scope, state, guards);
    }
    case "map":
      return guards.checkArray(
        evaluateArray(node.array, input, scope, state, guards, "map").map((item) =>
          evaluateNode(node.body, input, childScope(scope, node.as, item), state, guards),
        ),
      );
    case "filter":
      return guards.checkArray(
        evaluateArray(node.array, input, scope, state, guards, "filter").filter((item) =>
          Boolean(
            evaluateNode(node.body, input, childScope(scope, node.as, item), state, guards),
          ),
        ),
      );
    case "reduce": {
      const array = evaluateArray(node.array, input, scope, state, guards, "reduce");
      let accumulator = evaluateNode(node.init, input, scope, state, guards);
      for (const item of array) {
        const iterationScope = childScope(scope, node.as, item);
        iterationScope[node.acc] = accumulator;
        accumulator = evaluateNode(node.body, input, iterationScope, state, guards);
      }
      return accumulator;
    }
    default:
      return evaluateFunction(node, input, scope, state, guards);
  }
}

function evaluateFunction(node, input, scope, state, guards) {
  const spec = TRANSFORM_FUNCTION_OPERATIONS[node.op];
  const implementation = OPERATIONS[node.op];
  if (!spec || typeof implementation !== "function") {
    throw new TransformEvaluationError("unknown_operation", `Операция "${node.op}" недопустима.`);
  }

  const args = (node.args ?? []).map((argument) =>
    evaluateNode(argument, input, scope, state, guards),
  );
  return implementation(args, guards);
}

function evaluateArray(expression, input, scope, state, guards, op) {
  const value = evaluateNode(expression, input, scope, state, guards);
  if (!Array.isArray(value)) {
    throw new TransformEvaluationError("type_error", `${op}: ожидался массив.`);
  }
  if (value.length > state.limits.maxArrayLength) {
    throw new TransformEvaluationError(
      "array_too_long",
      `${op}: входной массив превышает лимит ${state.limits.maxArrayLength}.`,
    );
  }
  return value;
}

function childScope(parent, name, value) {
  const scope = Object.create(parent);
  scope[name] = value;
  return scope;
}

function accessPath(object, path) {
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
    if (DANGEROUS_KEYS.has(segment)) {
      return null;
    }
    current = isPlainObject(current) && Object.hasOwn(current, segment) ? current[segment] : null;
  }
  return current;
}

function cloneLiteral(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return structuredClone(value);
}

function byteLength(value) {
  if (value === undefined) {
    return 0;
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TransformEvaluationError("result_not_serializable", "Результат не сериализуется в JSON.");
  }
  return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : 0;
}
