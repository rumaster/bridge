import { Buffer } from "node:buffer";

import { TRANSFORM_DEFAULT_LIMITS, configPortRows } from "@bridge/contracts/c5-workflow";
import { WorkflowExecutionError } from "../core/errors.js";
import { evaluateTransformCode } from "../transform/code-sandbox.js";

/**
 * Transform (ТЗ §13.4, Ревизия 2026-07-15) — pure-функция без exec-портов:
 * исполняется лениво, когда её выход кому-то понадобился, и мемоизируется.
 *
 * Тело — произвольный JS-текст. Режим `expression` (JSON-AST по whitelist) убран:
 * у узла остался только код. Изоляция держится на трёх эшелонах песочницы (см.
 * `transform/code-sandbox.ts`): фильтр запрещённых токенов, отдельный процесс с
 * `node:vm` без Node-глобалей и жёсткие таймаут/память.
 *
 * Код получает объект `input` (ключи = имена входных портов) и возвращает
 * значение через `return`. Выходы читаются путём от `{ result }`: порт с
 * `path: "result.name"` получит `result.name`, без `path` — весь возврат. Порты
 * объявлены в `config.outputs`, а не выводятся из кода: иначе редактор не мог бы
 * нарисовать их до первого запуска.
 */
export const transformNode = {
  type: "transform",

  validate(config, { path, errors, limits = TRANSFORM_DEFAULT_LIMITS }) {
    // Наличие code и форму портов проверяет контракт C5; здесь — только лимит.
    if (typeof config?.code !== "string") return;
    const maxCodeLength = Number.isInteger(limits.maxCodeLength)
      ? limits.maxCodeLength
      : TRANSFORM_DEFAULT_LIMITS.maxCodeLength;
    if (Buffer.byteLength(config.code, "utf8") > maxCodeLength) {
      errors.push({ path: `${path}.code`, message: `code превышает лимит ${maxCodeLength} байт.` });
    }
  },

  async execute({ node, input, limits = TRANSFORM_DEFAULT_LIMITS }: any) {
    const config = node.config ?? {};
    const result = await evaluateTransformCode(config.code, input, limits);
    const rows = configPortRows(config.outputs);
    if (rows.length === 0) {
      return { outputs: { result } };
    }

    const source = { result };
    const outputs: Record<string, unknown> = {};
    for (const row of rows) {
      outputs[row.name] = readPath(source, row.path ?? "result");
    }
    return { outputs };
  },
};

/** Читает путь вида `result.a.b` (и индексы массива `result.items.0`) от возврата кода. */
function readPath(source: unknown, path: string): unknown {
  const segments = String(path).split(".").filter((segment) => segment !== "");
  let current: any = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return null;
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new WorkflowExecutionError("invalid_output_path", `Сегмент пути "${segment}" запрещён.`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) && index >= 0 && index < current.length ? current[index] : null;
      continue;
    }
    current = typeof current === "object" && Object.hasOwn(current, segment) ? current[segment] : null;
  }
  return current ?? null;
}
