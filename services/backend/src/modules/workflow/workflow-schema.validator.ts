import { BadRequestException } from "@nestjs/common";

// Импорт по имени пакета (не относительным путём к исходникам) и именно
// `c5-workflow`, а не `c5`: Backend — CommonJS с rootDir "src", он резолвит
// условие "require" в собранный dist/cjs. Подпакет `c5` не годится — он тянет
// `node:fs` и `c4.ts`; `c5-workflow` не имеет импортов вовсе.
import {
  TRANSFORM_DEFAULT_LIMITS,
  WorkflowContractError,
  isWorkflowGraphShape,
  validateWorkflowGraphContract,
} from "@bridge/contracts/c5-workflow";

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
  codeMemoryMb: number;
  codeTimeoutMs: number;
  maxCodeLength: number;
  maxResultBytes: number;
}

/**
 * Ревизия 2026-07-15 (решение A4, дефекты D1/D8). Раньше здесь жила вторая,
 * независимая реализация валидации схемы на 978 строк — она успела разойтись с
 * движком: читала `connection.port` вместо `fromPort` и схлопывала все исходящие
 * связи узла в один ключ, из-за чего узел ветвления с обеими ветками true/false
 * нельзя было сохранить через API.
 *
 * Теперь форму графа, порты, совместимость типов, отсутствие циклов и конфиг
 * узлов проверяет контракт C5 (`packages/contracts`), общий для Backend, движка
 * и редактора. Здесь остаются только вещи уровня Backend: лимиты песочницы,
 * форма исключения HTTP и сбор ссылок на субсхемы.
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
  if (typeof error.details.nodeId === "string") return `$.nodes[id=${String(error.details.nodeId)}]`;
  return "$";
}

function resolveLimits(limits: Partial<TransformLimits> | undefined): TransformLimits {
  return { ...TRANSFORM_DEFAULT_LIMITS, ...(limits ?? {}) } as TransformLimits;
}

/**
 * Полная валидация схемы — применяется при копировании драфта в рабочую версию.
 * Драфт сохраняется автосохранением, поэтому недостроенная схема обязана
 * сохраняться: для неё есть `validateWorkflowSchemaShape`.
 */
export function validateWorkflowSchema(
  schema: unknown,
  options: WorkflowSchemaValidationOptions = {},
): WorkflowSchemaValidationResult {
  const limits = resolveLimits(options.limits);
  const errors: WorkflowSchemaIssue[] = [];

  if (!isRecord(schema)) {
    return { errors: [{ path: "$", message: "Схема должна быть JSON-объектом." }], valid: false };
  }

  try {
    validateWorkflowGraphContract(schema);
  } catch (error) {
    if (!(error instanceof WorkflowContractError)) throw error;
    errors.push({ path: contractErrorPath(error), message: error.message });
  }

  if (Array.isArray(schema.nodes)) {
    schema.nodes.forEach((node, index) => {
      validateNodeLimits(node, `$.nodes[${index}]`, errors, limits);
    });
  }

  return { errors, valid: errors.length === 0 };
}

/**
 * Проверка формы графа для автосохранения драфта: схема может быть недостроена
 * (событие ещё не выбрано, порты висят), но обязана оставаться JSON-графом,
 * который редактор сможет открыть снова.
 */
export function validateWorkflowSchemaShape(schema: unknown): WorkflowSchemaValidationResult {
  if (!isWorkflowGraphShape(schema)) {
    return {
      errors: [{ path: "$", message: "Драфт должен быть графом схемы: { schema_version, kind, nodes, connections }." }],
      valid: false,
    };
  }
  return { errors: [], valid: true };
}

export function createWorkflowSchemaValidationException(
  errors: WorkflowSchemaIssue[],
): BadRequestException {
  return new BadRequestException({
    code: "WORKFLOW_SCHEMA_INVALID",
    description: "Workflow schema failed validation before persistence.",
    errors,
    humanMessage: "Схема Workflow не прошла валидацию.",
  });
}

export function collectWorkflowSubSchemaSlugs(schema: unknown): string[] {
  const slugs = new Set<string>();
  collectSubSchemaSlugsFromSchema(schema, slugs);
  return [...slugs].sort();
}

/** Лимиты песочницы — единственное, чего контракт знать не может. */
function validateNodeLimits(
  node: unknown,
  path: string,
  errors: WorkflowSchemaIssue[],
  limits: TransformLimits,
): void {
  if (!isRecord(node) || node.type !== "transform") return;
  const config = isRecord(node.config) ? node.config : {};
  const code = config.code;
  if (typeof code === "string" && code.length > limits.maxCodeLength) {
    errors.push({
      path: `${path}.config.code`,
      message: `Длина кода превышает предел ${limits.maxCodeLength} символов.`,
    });
  }
}

function collectSubSchemaSlugsFromSchema(schema: unknown, slugs: Set<string>): void {
  if (!isRecord(schema) || !Array.isArray(schema.nodes)) return;
  for (const node of schema.nodes) {
    if (!isRecord(node) || node.type !== "sub_schema") continue;
    const config = isRecord(node.config) ? node.config : {};
    if (typeof config.subSchemaSlug === "string" && config.subSchemaSlug.trim()) {
      slugs.add(config.subSchemaSlug.trim());
    }
    // Инлайн-граф субсхемы может ссылаться на другие субсхемы — собираем транзитивно.
    if (isRecord(config.graph)) collectSubSchemaSlugsFromSchema(config.graph, slugs);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
