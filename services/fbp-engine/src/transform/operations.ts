import { TransformEvaluationError } from "./errors.js";

/**
 * Семантика whitelist-операций Transform Node (ТЗ §13.4). Все функции чисты и
 * работают ТОЛЬКО над уже вычисленными значениями-данными: нет доступа к среде,
 * сети, ФС, секретам, системному времени или ГСЧ — таких операций в наборе нет
 * «по построению». Имена операций синхронизированы с whitelist контракта C5
 * (`TRANSFORM_FUNCTION_OPERATIONS`); дрейф ловится контрактным тестом.
 *
 * Каждая функция получает `(args, guards)`, где `args` — вычисленные аргументы,
 * `guards` — ограничители размера строк/массивов (§13.4, лимиты ресурсов).
 */

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function typeError(message) {
  return new TransformEvaluationError("type_error", message);
}

function asNumber(value, op) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw typeError(`${op}: аргумент должен быть конечным числом.`);
  }
  return value;
}

function asString(value, op) {
  if (typeof value !== "string") {
    throw typeError(`${op}: аргумент должен быть строкой.`);
  }
  return value;
}

function asArray(value, op) {
  if (!Array.isArray(value)) {
    throw typeError(`${op}: аргумент должен быть массивом.`);
  }
  return value;
}

function asObject(value, op) {
  if (!isPlainObject(value)) {
    throw typeError(`${op}: аргумент должен быть объектом.`);
  }
  return value;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Безопасно назначить собственное свойство результату, нейтрализуя попытку
 * загрязнения прототипа (`__proto__` и т.п. становятся обычными own-полями).
 */
function setKey(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function safeKey(value, op) {
  const key = asString(value, op);
  if (DANGEROUS_KEYS.has(key)) {
    throw typeError(`${op}: ключ "${key}" запрещён.`);
  }
  return key;
}

function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

export const OPERATIONS = Object.freeze({
  // --- Арифметика ---------------------------------------------------------
  add: (args) => args.reduce((sum, v) => sum + asNumber(v, "add"), 0),
  sub: ([a, b]) => asNumber(a, "sub") - asNumber(b, "sub"),
  mul: (args) => args.reduce((product, v) => product * asNumber(v, "mul"), 1),
  div: ([a, b]) => {
    const divisor = asNumber(b, "div");
    if (divisor === 0) {
      throw typeError("div: деление на ноль.");
    }
    return asNumber(a, "div") / divisor;
  },
  mod: ([a, b]) => {
    const divisor = asNumber(b, "mod");
    if (divisor === 0) {
      throw typeError("mod: деление на ноль.");
    }
    return asNumber(a, "mod") % divisor;
  },
  neg: ([a]) => -asNumber(a, "neg"),
  abs: ([a]) => Math.abs(asNumber(a, "abs")),
  pow: ([a, b]) => asNumber(a, "pow") ** asNumber(b, "pow"),
  floor: ([a]) => Math.floor(asNumber(a, "floor")),
  ceil: ([a]) => Math.ceil(asNumber(a, "ceil")),
  round: ([a]) => Math.round(asNumber(a, "round")),
  min: (args) => Math.min(...args.map((v) => asNumber(v, "min"))),
  max: (args) => Math.max(...args.map((v) => asNumber(v, "max"))),
  to_number: ([a]) => {
    if (typeof a === "number") {
      return asNumber(a, "to_number");
    }
    if (typeof a === "string" && a.trim() !== "") {
      const parsed = Number(a);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    throw typeError("to_number: значение не приводится к числу.");
  },

  // --- Сравнения ----------------------------------------------------------
  eq: ([a, b]) => deepEqual(a, b),
  ne: ([a, b]) => !deepEqual(a, b),
  lt: ([a, b]) => compare(a, b) < 0,
  lte: ([a, b]) => compare(a, b) <= 0,
  gt: ([a, b]) => compare(a, b) > 0,
  gte: ([a, b]) => compare(a, b) >= 0,

  // --- Логика -------------------------------------------------------------
  and: (args) => args.every(truthy),
  or: (args) => args.some(truthy),
  not: ([a]) => !truthy(a),
  coalesce: (args) => {
    for (const value of args) {
      if (value !== null && value !== undefined) {
        return value;
      }
    }
    return null;
  },

  // --- Предикаты типов ----------------------------------------------------
  is_null: ([a]) => a === null || a === undefined,
  is_number: ([a]) => typeof a === "number" && Number.isFinite(a),
  is_string: ([a]) => typeof a === "string",
  is_boolean: ([a]) => typeof a === "boolean",
  is_array: ([a]) => Array.isArray(a),
  is_object: ([a]) => isPlainObject(a),

  // --- Строки -------------------------------------------------------------
  concat: (args, guards) =>
    guards.checkString(args.map((v) => asString(v, "concat")).join("")),
  upper: ([a], guards) => guards.checkString(asString(a, "upper").toUpperCase()),
  lower: ([a], guards) => guards.checkString(asString(a, "lower").toLowerCase()),
  trim: ([a]) => asString(a, "trim").trim(),
  split: ([a, sep], guards) =>
    guards.checkArray(asString(a, "split").split(asString(sep, "split"))),
  replace: ([a, from, to], guards) =>
    guards.checkString(
      asString(a, "replace").split(asString(from, "replace")).join(asString(to, "replace")),
    ),
  substring: ([a, start, end]) =>
    asString(a, "substring").substring(asNumber(start, "substring"), asNumber(end, "substring")),
  str_includes: ([a, needle]) => asString(a, "str_includes").includes(asString(needle, "str_includes")),
  starts_with: ([a, prefix]) => asString(a, "starts_with").startsWith(asString(prefix, "starts_with")),
  ends_with: ([a, suffix]) => asString(a, "ends_with").endsWith(asString(suffix, "ends_with")),
  to_string: ([a]) => stringify(a),

  // --- Длина (строка или массив) -----------------------------------------
  length: ([a]) => {
    if (typeof a === "string" || Array.isArray(a)) {
      return a.length;
    }
    throw typeError("length: ожидались строка или массив.");
  },

  // --- Массивы ------------------------------------------------------------
  join: ([a, sep], guards) =>
    guards.checkString(asArray(a, "join").map((v) => stringify(v)).join(asString(sep, "join"))),
  slice: ([a, start, end], guards) =>
    guards.checkArray(asArray(a, "slice").slice(asNumber(start, "slice"), asNumber(end, "slice"))),
  array_includes: ([a, needle]) => asArray(a, "array_includes").some((item) => deepEqual(item, needle)),
  array_concat: (args, guards) => {
    const result = [];
    for (const value of args) {
      for (const item of asArray(value, "array_concat")) {
        result.push(item);
      }
    }
    return guards.checkArray(result);
  },
  first: ([a]) => {
    const array = asArray(a, "first");
    return array.length > 0 ? array[0] : null;
  },
  last: ([a]) => {
    const array = asArray(a, "last");
    return array.length > 0 ? array[array.length - 1] : null;
  },
  reverse: ([a], guards) => guards.checkArray(asArray(a, "reverse").slice().reverse()),
  unique: ([a], guards) => {
    const result = [];
    for (const item of asArray(a, "unique")) {
      if (!result.some((existing) => deepEqual(existing, item))) {
        result.push(item);
      }
    }
    return guards.checkArray(result);
  },
  flatten: ([a], guards) => {
    const result = [];
    for (const item of asArray(a, "flatten")) {
      if (Array.isArray(item)) {
        for (const inner of item) {
          result.push(inner);
        }
      } else {
        result.push(item);
      }
    }
    return guards.checkArray(result);
  },

  // --- Объекты ------------------------------------------------------------
  keys: ([a], guards) => guards.checkArray(Object.keys(asObject(a, "keys"))),
  values: ([a], guards) => guards.checkArray(Object.values(asObject(a, "values"))),
  entries: ([a], guards) =>
    guards.checkArray(Object.entries(asObject(a, "entries")).map(([key, value]) => [key, value])),
  from_entries: ([a], guards) => {
    const result = {};
    for (const entry of asArray(a, "from_entries")) {
      const pair = asArray(entry, "from_entries");
      setKey(result, safeKey(pair[0], "from_entries"), pair[1]);
    }
    guards.checkResultSize(result);
    return result;
  },
  merge: (args, guards) => {
    const result = {};
    for (const value of args) {
      for (const [key, item] of Object.entries(asObject(value, "merge"))) {
        setKey(result, key, item);
      }
    }
    guards.checkResultSize(result);
    return result;
  },
  pick: ([a, ...rawKeys]) => {
    const source = asObject(a, "pick");
    const result = {};
    for (const rawKey of rawKeys) {
      const key = safeKey(rawKey, "pick");
      if (Object.hasOwn(source, key)) {
        setKey(result, key, source[key]);
      }
    }
    return result;
  },
  omit: ([a, ...rawKeys]) => {
    const source = asObject(a, "omit");
    const drop = new Set(rawKeys.map((key) => safeKey(key, "omit")));
    const result = {};
    for (const [key, value] of Object.entries(source)) {
      if (!drop.has(key)) {
        setKey(result, key, value);
      }
    }
    return result;
  },
  has: ([a, key]) => Object.hasOwn(asObject(a, "has"), safeKey(key, "has")),

  // --- Даты (детерминированы; только над явными значениями, без «now») ----
  date_parse_iso: ([a]) => {
    const parsed = Date.parse(asString(a, "date_parse_iso"));
    if (Number.isNaN(parsed)) {
      throw typeError("date_parse_iso: некорректная дата.");
    }
    return parsed;
  },
  date_to_iso: ([a]) => {
    const ms = asNumber(a, "date_to_iso");
    if (!Number.isSafeInteger(ms)) {
      throw typeError("date_to_iso: миллисекунды вне допустимого диапазона.");
    }
    return new Date(ms).toISOString();
  },
  date_add_days: ([a, days]) => asNumber(a, "date_add_days") + asNumber(days, "date_add_days") * 86400000,
  date_diff_days: ([a, b]) =>
    (asNumber(a, "date_diff_days") - asNumber(b, "date_diff_days")) / 86400000,
});

function truthy(value) {
  return Boolean(value);
}

function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  }
  throw typeError("Сравнение поддерживается только для чисел или строк одного типа.");
}

function stringify(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
