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

/**
 * Ошибка неизменяемости версии Workflow (ТЗ §13.10). Возникает при попытке
 * ПЕРЕЗАПИСАТЬ уже опубликованную версию (тот же `version_no`) — правка схемы
 * обязана порождать НОВУЮ версию, а не менять существующую. Зеркалит запрет
 * `UPDATE/DELETE` на уровне БД (триггер `workflow_versions_immutable`).
 */
export class VersionImmutabilityError extends Error {
  constructor(message, { workflowId = null, versionNo = null } = {}) {
    super(message);
    this.name = "VersionImmutabilityError";
    this.reason = "version_immutable";
    this.workflowId = workflowId;
    this.versionNo = versionNo;
  }
}

/**
 * Ошибка обращения к несуществующей версии/экземпляру/состоянию Workflow. Держит
 * машиночитаемую `reason`, чтобы вызвавший фасад мог различить причину (например,
 * версия не найдена против экземпляр не найден).
 */
export class WorkflowStoreError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "WorkflowStoreError";
    this.reason = reason;
  }
}
