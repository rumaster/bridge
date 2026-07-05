import {
  FBP_INPUT_SOURCE_KINDS,
  TRANSFORM_DEFAULT_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
} from "../../../../packages/contracts/src/c5.js";
import { WorkflowSchemaValidationError } from "../core/errors.js";
import { findCycle } from "../core/graph.js";
import { getNodeDefinition } from "../nodes/registry.js";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INPUT_KINDS = new Set(FBP_INPUT_SOURCE_KINDS);

/**
 * Валидация схемы Workflow НА ЭТАПЕ СОХРАНЕНИЯ (ТЗ §13.13-п.5, §16.7). Всё, что
 * можно проверить статически, проверяется до создания новой версии: версия
 * схемы, уникальность и типы узлов, конфигурация каждого узла (в т.ч. запрет
 * операций Transform вне whitelist и запрет подмены арендатора), корректность
 * «проводки» входов, соединения и ОТСУТСТВИЕ ЦИКЛОВ (граф обязан быть DAG —
 * гарантия завершимости исполнения).
 *
 * Возвращает `{ valid, errors: [{ path, message }] }`.
 */
export function validateWorkflowSchema(schema, options = {}) {
  const limits = { ...TRANSFORM_DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const errors = [];

  if (!isRecord(schema)) {
    return { valid: false, errors: [{ path: "$", message: "Схема должна быть JSON-объектом." }] };
  }

  if (schema.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push({
      path: "$.schema_version",
      message: `schema_version должен быть "${WORKFLOW_SCHEMA_VERSION}".`,
    });
  }

  if (!Array.isArray(schema.nodes) || schema.nodes.length === 0) {
    errors.push({ path: "$.nodes", message: "nodes должен быть непустым массивом узлов." });
    return { valid: false, errors };
  }

  const nodeIds = collectNodeIds(schema.nodes, errors);

  schema.nodes.forEach((node, index) => {
    validateNode(node, index, nodeIds, errors, limits);
  });

  validateEntry(schema.entry, nodeIds, errors);
  validateConnections(schema.connections, schema.nodes, nodeIds, errors);
  validateAcyclic(schema, errors);

  return { valid: errors.length === 0, errors };
}

export function assertWorkflowSchema(schema, options = {}) {
  const result = validateWorkflowSchema(schema, options);
  if (!result.valid) {
    throw new WorkflowSchemaValidationError(result.errors);
  }
  return schema;
}

function collectNodeIds(nodes, errors) {
  const ids = new Set();
  nodes.forEach((node, index) => {
    const id = isRecord(node) ? node.id : undefined;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push({ path: `$.nodes[${index}].id`, message: "id узла должен быть непустой строкой." });
      return;
    }
    if (ids.has(id)) {
      errors.push({ path: `$.nodes[${index}].id`, message: `Дублирующийся id узла "${id}".` });
      return;
    }
    ids.add(id);
  });
  return ids;
}

function validateNode(node, index, nodeIds, errors, limits) {
  const path = `$.nodes[${index}]`;
  if (!isRecord(node)) {
    errors.push({ path, message: "Узел должен быть объектом." });
    return;
  }

  const definition = getNodeDefinition(node.type);
  if (!definition) {
    errors.push({ path: `${path}.type`, message: `Неизвестный тип узла "${node.type}".` });
  } else {
    definition.validate(node.config ?? {}, { path: `${path}.config`, errors, limits });
  }

  if (node.input !== undefined) {
    validateInputSpec(node.input, `${path}.input`, node.id, nodeIds, errors);
  }
}

function validateInputSpec(inputSpec, path, selfId, nodeIds, errors) {
  if (!isRecord(inputSpec)) {
    errors.push({ path, message: "input должен быть объектом отображения порт → источник." });
    return;
  }
  for (const [key, source] of Object.entries(inputSpec)) {
    const sourcePath = `${path}.${key}`;
    if (DANGEROUS_KEYS.has(key)) {
      errors.push({ path: sourcePath, message: `Ключ входа "${key}" запрещён.` });
      continue;
    }
    if (!isRecord(source) || typeof source.kind !== "string" || !INPUT_KINDS.has(source.kind)) {
      errors.push({
        path: `${sourcePath}.kind`,
        message: `Источник входа должен иметь kind из ${[...INPUT_KINDS].join(", ")}.`,
      });
      continue;
    }
    if (source.kind === "node") {
      if (source.node === selfId) {
        errors.push({ path: `${sourcePath}.node`, message: "Узел не может ссылаться на собственный результат." });
      } else if (!nodeIds.has(source.node)) {
        errors.push({ path: `${sourcePath}.node`, message: `Ссылка на несуществующий узел "${source.node}".` });
      }
    }
    if (source.kind !== "const" && source.path !== undefined) {
      validatePathSegments(source.path, `${sourcePath}.path`, errors);
    }
  }
}

function validatePathSegments(segments, path, errors) {
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
    errors.push({ path: segmentPath, message: "Сегмент пути должен быть строкой или неотрицательным целым." });
  });
}

function validateEntry(entry, nodeIds, errors) {
  if (typeof entry !== "string" || entry.trim() === "") {
    errors.push({ path: "$.entry", message: "entry должен быть непустой строкой (id стартового узла)." });
    return;
  }
  if (!nodeIds.has(entry)) {
    errors.push({ path: "$.entry", message: `entry ссылается на несуществующий узел "${entry}".` });
  }
}

function validateConnections(connections, nodes, nodeIds, errors) {
  if (connections === undefined) {
    return;
  }
  if (!Array.isArray(connections)) {
    errors.push({ path: "$.connections", message: "connections должен быть массивом соединений." });
    return;
  }

  const seen = new Set();
  connections.forEach((connection, index) => {
    const path = `$.connections[${index}]`;
    if (!isRecord(connection)) {
      errors.push({ path, message: "Соединение должно быть объектом." });
      return;
    }
    if (!nodeIds.has(connection.from)) {
      errors.push({ path: `${path}.from`, message: `Соединение исходит из несуществующего узла "${connection.from}".` });
    }
    if (!nodeIds.has(connection.to)) {
      errors.push({ path: `${path}.to`, message: `Соединение ведёт в несуществующий узел "${connection.to}".` });
    }
    const port = connection.port ?? "out";
    if (typeof port !== "string" || port.trim() === "") {
      errors.push({ path: `${path}.port`, message: "port должен быть непустой строкой." });
      return;
    }
    const key = `${connection.from}${port}`;
    if (seen.has(key)) {
      errors.push({ path: `${path}.port`, message: `Дублирующийся выходной порт "${port}" узла "${connection.from}".` });
    }
    seen.add(key);
  });
}

function validateAcyclic(schema, errors) {
  const cycle = findCycle(schema);
  if (cycle) {
    errors.push({
      path: "$.connections",
      message: `Граф должен быть ациклическим (DAG). Обнаружен цикл: ${cycle.join(" → ")}.`,
    });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
