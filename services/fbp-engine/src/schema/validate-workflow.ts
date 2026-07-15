import {
  TRANSFORM_DEFAULT_LIMITS,
  WorkflowContractError,
  validateWorkflowGraphContract,
} from "../../../../packages/contracts/src/c5.js";
import { WorkflowSchemaValidationError } from "../core/errors.js";
import { getNodeDefinition } from "../nodes/registry.js";

/** Опции валидации схемы Workflow. */
export interface ValidateWorkflowOptions {
  limits?: Record<string, unknown>;
}

interface ValidationError {
  path: string;
  message: string;
}

/**
 * Ошибки контракта — про форму графа, порты и связи; ошибки реестра — про конфиг
 * конкретного узла. Разделение путей нужно, чтобы редактор мог подсветить либо
 * связь, либо панель свойств.
 */
const CONTRACT_ERROR_PATHS: Record<string, string> = {
  invalid_graph_shape: "$",
  invalid_graph_kind: "$.kind",
  unsupported_schema_version: "$.schema_version",
  single_start: "$.nodes",
  single_end: "$.nodes",
  missing_event_source: "$.nodes",
  exec_cycle: "$.connections",
};

function contractErrorPath(error: WorkflowContractError): string {
  const known = CONTRACT_ERROR_PATHS[error.code];
  if (known) return known;
  if (typeof error.details.connectionId === "string") return "$.connections";
  if (typeof error.details.nodeId === "string") return `$.nodes[id=${error.details.nodeId}]`;
  return "$";
}

/**
 * Валидация схемы Workflow НА ЭТАПЕ СОХРАНЕНИЯ (ТЗ §13.13-п.5, §16.7). Всё, что
 * можно проверить статически, проверяется до создания новой версии.
 *
 * Ревизия 2026-07-15: форма графа, порты, совместимость типов и отсутствие
 * циклов больше здесь не дублируются — это делает контракт C5
 * (`validateWorkflowGraphContract`), единый для движка, Backend и редактора.
 * Здесь остаётся только то, чего контракт знать не может: конфигурация узла по
 * правилам реестра движка (whitelist операций Transform, лимиты песочницы).
 *
 * Возвращает `{ valid, errors: [{ path, message }] }`.
 */
export function validateWorkflowSchema(schema: unknown, options: ValidateWorkflowOptions = {}) {
  const limits = { ...TRANSFORM_DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const errors: ValidationError[] = [];

  if (!isRecord(schema)) {
    return { valid: false, errors: [{ path: "$", message: "Схема должна быть JSON-объектом." }] };
  }

  try {
    validateWorkflowGraphContract(schema);
  } catch (error) {
    if (!(error instanceof WorkflowContractError)) throw error;
    errors.push({ path: contractErrorPath(error), message: error.message });
  }

  if (Array.isArray(schema.nodes)) {
    schema.nodes.forEach((node: unknown, index: number) => {
      if (!isRecord(node) || typeof node.type !== "string") return;
      // Неизвестный тип уже отверг контракт; start/end исполняет ядро, а не узел реестра.
      const definition = getNodeDefinition(node.type);
      if (!definition) return;
      definition.validate(node.config ?? {}, { path: `$.nodes[${index}].config`, errors, limits });
    });
  }

  return { valid: errors.length === 0, errors };
}

export function assertWorkflowSchema(schema: unknown, options: ValidateWorkflowOptions = {}) {
  const result = validateWorkflowSchema(schema, options);
  if (!result.valid) {
    throw new WorkflowSchemaValidationError(result.errors);
  }
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
