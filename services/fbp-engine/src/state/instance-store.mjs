import { WorkflowStoreError } from "../core/errors.mjs";

const INSTANCE_STATUSES = new Set(["pending", "running", "waiting", "completed", "failed", "cancelled"]);

/**
 * Референс-модель таблиц `workflow_instances` (version pinning) и
 * `workflow_instance_state` (состояние ВНЕ исполнителя, stateless executor,
 * ТЗ §25.3). В бою этими таблицами владеет Backend, SVC-FBP работает с ними по
 * C3; здесь — детерминированная модель для тестов и для инкапсуляции инвариантов:
 *
 *  - **version pinning:** экземпляр создаётся с зафиксированной `version_id`,
 *    которая после создания не меняется (публикация новой версии на него не влияет);
 *  - **stateless executor:** снимок состояния экземпляра хранится отдельно от
 *    исполнителя. Любой узел-исполнитель поднимает состояние из хранилища и
 *    продолжает экземпляр — память между шагами исполнителю не нужна.
 *
 * Мультиарендность «по построению»: всё изолировано по `organization_id`.
 */
export function createInstanceStore({ now = () => new Date().toISOString() } = {}) {
  const instances = new Map(); // `${org}${instanceId}` → instance record
  const states = new Map(); // `${org}${instanceId}` → { state, updated_at }

  function key(organizationId, instanceId) {
    return `${organizationId}${instanceId}`;
  }

  function requireId(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new WorkflowStoreError("invalid_argument", `${field} должен быть непустой строкой.`);
    }
    return value;
  }

  function loadInstance(organizationId, instanceId) {
    const record = instances.get(key(organizationId, instanceId));
    if (!record) {
      throw new WorkflowStoreError(
        "instance_not_found",
        `Экземпляр "${instanceId}" не найден у арендатора "${organizationId}".`,
      );
    }
    return record;
  }

  return {
    /**
     * Создать экземпляр, ЗАКРЕПИВ его за версией (`versionId`). Это и есть version
     * pinning: связь экземпляр↔версия неизменна на всём его жизненном цикле.
     */
    createInstance({ organizationId, workflowId, versionId, instanceId, status = "running" } = {}) {
      requireId(organizationId, "organization_id");
      requireId(workflowId, "workflow_id");
      requireId(versionId, "version_id");
      requireId(instanceId, "instance_id");
      if (!INSTANCE_STATUSES.has(status)) {
        throw new WorkflowStoreError("invalid_argument", `Недопустимый статус экземпляра "${status}".`);
      }
      const k = key(organizationId, instanceId);
      if (instances.has(k)) {
        throw new WorkflowStoreError(
          "instance_exists",
          `Экземпляр "${instanceId}" уже существует — повторное создание запрещено.`,
        );
      }
      const createdAt = now();
      const record = {
        id: instanceId,
        organization_id: organizationId,
        workflow_id: workflowId,
        version_id: versionId,
        status,
        started_at: createdAt,
        finished_at: null,
        created_at: createdAt,
      };
      instances.set(k, record);
      return { ...record };
    },

    /** Получить экземпляр (с закреплённой версией). Бросает, если не найден. */
    getInstance({ organizationId, instanceId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(instanceId, "instance_id");
      return { ...loadInstance(organizationId, instanceId) };
    },

    /** Обновить статус/временные метки экземпляра. `version_id` менять нельзя. */
    updateInstance({ organizationId, instanceId, status, finishedAt } = {}) {
      const record = loadInstance(organizationId, instanceId);
      if (status !== undefined) {
        if (!INSTANCE_STATUSES.has(status)) {
          throw new WorkflowStoreError("invalid_argument", `Недопустимый статус экземпляра "${status}".`);
        }
        record.status = status;
      }
      if (finishedAt !== undefined) {
        record.finished_at = finishedAt;
      }
      return { ...record };
    },

    /**
     * Сохранить снимок состояния экземпляра в `workflow_instance_state` (upsert).
     * Снимок замораживается копией — исполнитель не должен полагаться на общий с
     * хранилищем объект. Требует существующего экземпляра (FK на `workflow_instances`).
     */
    saveState({ organizationId, instanceId, state } = {}) {
      requireId(organizationId, "organization_id");
      requireId(instanceId, "instance_id");
      loadInstance(organizationId, instanceId);
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new WorkflowStoreError("invalid_argument", "state должен быть JSON-объектом.");
      }
      const record = { instance_id: instanceId, organization_id: organizationId, state: structuredClone(state), updated_at: now() };
      states.set(key(organizationId, instanceId), record);
      return { ...record, state: structuredClone(record.state) };
    },

    /**
     * Загрузить снимок состояния экземпляра (для продолжения другим узлом). Копия,
     * не общий объект. Возвращает `null`, если состояние ещё не сохранялось.
     */
    loadState({ organizationId, instanceId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(instanceId, "instance_id");
      const record = states.get(key(organizationId, instanceId));
      return record ? structuredClone(record.state) : null;
    },

    /** Удалить внешнее состояние (например, после завершения экземпляра). */
    clearState({ organizationId, instanceId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(instanceId, "instance_id");
      return states.delete(key(organizationId, instanceId));
    },
  };
}
