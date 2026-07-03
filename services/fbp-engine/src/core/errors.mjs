/**
 * Ошибка валидации схемы Workflow НА ЭТАПЕ СОХРАНЕНИЯ (ТЗ §13.13-п.5, §16.7).
 * Держит машиночитаемый список `{ path, message }`, чтобы редактор Workflow
 * (SVC-ADMIN) мог показать проблемы до создания новой версии.
 */
export class WorkflowSchemaValidationError extends Error {
  constructor(errors) {
    super(
      `Схема Workflow не прошла валидацию: ${errors
        .map((error) => error.path)
        .join(", ")}`,
    );
    this.name = "WorkflowSchemaValidationError";
    this.errors = errors;
  }
}

/**
 * Ошибка ВРЕМЕНИ ИСПОЛНЕНИЯ узла графа. Несёт `node_id`, тип узла и причину,
 * чтобы попасть в журнал исполнения (`workflow_execution_logs`).
 */
export class WorkflowExecutionError extends Error {
  constructor(reason, message, { nodeId = null, nodeType = null } = {}) {
    super(message);
    this.name = "WorkflowExecutionError";
    this.reason = reason;
    this.nodeId = nodeId;
    this.nodeType = nodeType;
  }
}
