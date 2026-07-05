/**
 * Ошибки безопасного вычислителя Transform Node.
 *
 * `TransformValidationError` — на этапе валидации схемы (до сохранения, §13.4):
 * недопустимая операция/форма выражения. `TransformEvaluationError` — во время
 * исполнения: нарушение типов или превышение лимитов ресурсов (время/размер).
 */

/** Единичное нарушение валидации выражения Transform. */
export interface TransformValidationIssue {
  path: string;
  message: string;
  [key: string]: unknown;
}

export class TransformValidationError extends Error {
  readonly errors: TransformValidationIssue[];

  constructor(errors: TransformValidationIssue[] | unknown) {
    const list: TransformValidationIssue[] = Array.isArray(errors)
      ? errors
      : [{ path: "$", message: String(errors) }];
    super(`Transform expression validation failed: ${list.map((e) => e.path).join(", ")}`);
    this.name = "TransformValidationError";
    this.errors = list;
  }
}

export class TransformEvaluationError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "TransformEvaluationError";
    this.reason = reason;
  }
}
