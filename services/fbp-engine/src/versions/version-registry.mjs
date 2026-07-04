import { deterministicUuid } from "../core/ids.mjs";
import { VersionImmutabilityError, WorkflowStoreError } from "../core/errors.mjs";
import { validateWorkflowSchema } from "../schema/validate-workflow.mjs";

/**
 * Реестр НЕИЗМЕНЯЕМЫХ версий Workflow (ТЗ §13.10). Референс-модель таблиц
 * `workflows` и `workflow_versions`, которыми в бою владеет Backend, а SVC-FBP
 * читает/публикует их через C3. Инкапсулирует три инварианта вехи M4:
 *
 *  1. **Неизменяемость версий.** Публикация правки схемы порождает НОВУЮ версию с
 *     монотонным `version_no`; уже опубликованная версия не переписывается (её
 *     схема заморожена, попытка переиздать существующий `version_no` отклоняется).
 *     Зеркалит `UNIQUE(workflow_id, version_no)` и триггер `workflow_versions_immutable`.
 *  2. **Version pinning** (см. `resolveVersion`): при старте экземпляр закрепляется
 *     за конкретной версией, а не «за последней».
 *  3. **Переключение версии по умолчанию — конфигурацией** (`setDefaultVersion`):
 *     влияет только на ПОСЛЕДУЮЩИЕ запуски, не на уже идущие экземпляры.
 *
 * Мультиарендность «по построению»: всё изолировано по `organization_id` — версии
 * одного арендатора не видны другому.
 */
export function createVersionRegistry({
  now = () => new Date().toISOString(),
  validateSchema = validateWorkflowSchema,
} = {}) {
  // ключ арендатора+workflow → { versions: [record], defaultVersionId }
  const workflows = new Map();

  function key(organizationId, workflowId) {
    return `${organizationId}${workflowId}`;
  }

  function requireId(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new WorkflowStoreError("invalid_argument", `${field} должен быть непустой строкой.`);
    }
    return value;
  }

  function bucket(organizationId, workflowId) {
    const k = key(organizationId, workflowId);
    if (!workflows.has(k)) {
      workflows.set(k, { versions: [], defaultVersionId: null });
    }
    return workflows.get(k);
  }

  function findVersion(entry, versionId) {
    return entry?.versions.find((version) => version.id === versionId) ?? null;
  }

  return {
    /**
     * Опубликовать версию схемы. Схема валидируется НА ЭТАПЕ СОХРАНЕНИЯ (CP-5,
     * §16.7); при `versionNo`, указывающем на уже существующую версию, публикация
     * отклоняется (`VersionImmutabilityError`) — правка обязана дать новую версию.
     * Первая опубликованная версия становится версией по умолчанию.
     */
    publishVersion({ organizationId, workflowId, schema, createdBy = null, versionNo } = {}) {
      requireId(organizationId, "organization_id");
      requireId(workflowId, "workflow_id");

      const validation = validateSchema(schema, {});
      if (!validation.valid) {
        throw new WorkflowStoreError(
          "invalid_schema",
          `Схема версии не прошла валидацию на этапе сохранения: ${validation.errors
            .map((error) => error.path)
            .join(", ")}.`,
        );
      }

      const entry = bucket(organizationId, workflowId);
      const maxNo = entry.versions.reduce((max, version) => Math.max(max, version.version_no), 0);
      const nextNo = maxNo + 1;
      const targetNo = versionNo ?? nextNo;

      if (entry.versions.some((version) => version.version_no === targetNo)) {
        throw new VersionImmutabilityError(
          `Версия ${targetNo} уже опубликована — правка порождает новую версию, а не перезапись (ТЗ §13.10).`,
          { workflowId, versionNo: targetNo },
        );
      }
      if (!Number.isInteger(targetNo) || targetNo < 1) {
        throw new WorkflowStoreError("invalid_argument", "version_no должен быть положительным целым.");
      }

      const versionId = deterministicUuid([organizationId, workflowId, "workflow-version", targetNo]);
      const record = deepFreeze({
        id: versionId,
        organization_id: organizationId,
        workflow_id: workflowId,
        version_no: targetNo,
        schema: deepFreeze(structuredClone(schema)),
        created_by: createdBy,
        created_at: now(),
      });

      entry.versions.push(record);
      entry.versions.sort((a, b) => a.version_no - b.version_no);
      if (entry.defaultVersionId === null) {
        entry.defaultVersionId = versionId;
      }
      return record;
    },

    /** Получить конкретную версию (неизменяемую). Бросает, если версии нет. */
    getVersion({ organizationId, workflowId, versionId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(workflowId, "workflow_id");
      requireId(versionId, "version_id");
      const version = findVersion(workflows.get(key(organizationId, workflowId)), versionId);
      if (!version) {
        throw new WorkflowStoreError(
          "version_not_found",
          `Версия "${versionId}" не найдена для workflow "${workflowId}".`,
        );
      }
      return version;
    },

    /** Все версии workflow в порядке возрастания `version_no` (копия). */
    listVersions({ organizationId, workflowId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(workflowId, "workflow_id");
      return [...(workflows.get(key(organizationId, workflowId))?.versions ?? [])];
    },

    /**
     * Переключить версию по умолчанию — операция КОНФИГУРАЦИИ (ТЗ §13.10). Влияет
     * только на последующие запуски: уже идущие экземпляры закреплены за своей
     * версией (version pinning) и не переключаются.
     */
    setDefaultVersion({ organizationId, workflowId, versionId } = {}) {
      const version = this.getVersion({ organizationId, workflowId, versionId });
      workflows.get(key(organizationId, workflowId)).defaultVersionId = version.id;
      return version;
    },

    /** Текущая версия по умолчанию workflow (или бросает, если версий нет). */
    getDefaultVersion({ organizationId, workflowId } = {}) {
      requireId(organizationId, "organization_id");
      requireId(workflowId, "workflow_id");
      const entry = workflows.get(key(organizationId, workflowId));
      if (!entry || entry.defaultVersionId === null) {
        throw new WorkflowStoreError(
          "version_not_found",
          `У workflow "${workflowId}" нет опубликованных версий.`,
        );
      }
      return findVersion(entry, entry.defaultVersionId);
    },

    /**
     * Разрешить версию для ЗАКРЕПЛЕНИЯ за новым экземпляром (version pinning): явно
     * заданную `versionId` либо текущую версию по умолчанию. Возвращает
     * неизменяемую запись версии — именно она фиксируется в `workflow_instances`.
     */
    resolveVersion({ organizationId, workflowId, versionId } = {}) {
      if (versionId !== undefined && versionId !== null) {
        return this.getVersion({ organizationId, workflowId, versionId });
      }
      return this.getDefaultVersion({ organizationId, workflowId });
    },
  };
}

/** Глубокая заморозка: гарантирует, что опубликованная версия не мутируется. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
