/**
 * Ошибки безопасного вычислителя Transform Node.
 *
 * `TransformValidationError` — на этапе валидации схемы (до сохранения, §13.4):
 * недопустимая операция/форма выражения. `TransformEvaluationError` — во время
 * исполнения: нарушение типов или превышение лимитов ресурсов (время/размер).
 */

export class TransformValidationError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [{ path: "$", message: String(errors) }];
    super(`Transform expression validation failed: ${list.map((e) => e.path).join(", ")}`);
    this.name = "TransformValidationError";
    this.errors = list;
  }
}

export class TransformEvaluationError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = "TransformEvaluationError";
    this.reason = reason;
  }
}
