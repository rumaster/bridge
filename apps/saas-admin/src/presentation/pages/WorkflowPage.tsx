import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  Boxes,
  Database,
  Download,
  FileUp,
  FlaskConical,
  History,
  Link2,
  Play,
  Plus,
  Power,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";

import type {
  ImportWorkflowRequest,
  Workflow,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowSchema,
  WorkflowSchemaExport,
  WorkflowSubschema,
  WorkflowVersion
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import {
  SAFE_WORKFLOW_NODE_TYPES,
  WORKFLOW_BODY_GRAPH_CONFIG_KEY,
  createWorkflowConnection,
  createWorkflowBodyGraph,
  createWorkflowNode,
  isWorkflowSchema,
  validateWorkflowSchema,
  workflowNodeSupportsBodyGraph,
  workflowInstanceStatusLabel,
  workflowInstanceStatusTone,
  workflowNodeMutatesData,
  workflowNodePrimaryField,
  workflowNodeTypeDescription,
  workflowNodeTypeLabel,
  workflowStatusLabel,
  workflowStatusTone
} from "../../shared/workflow";
import { Badge, Button, Panel, TextInput } from "../../shared/ui-kit";

export default function WorkflowPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["platform_operator"]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [subschemas, setSubschemas] = useState<WorkflowSubschema[]>([]);
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!session || !canEdit) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    api.workflows
      .listWorkflows()
      .then((nextWorkflows) => {
        if (!active) {
          return;
        }
        setWorkflows(nextWorkflows);
        setSelectedWorkflowId((current) => current ?? nextWorkflows[0]?.id ?? null);
        setAlert(null);
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить список Workflow."));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, canEdit, session]);

  useEffect(() => {
    let active = true;

    if (!selectedWorkflowId) {
      setVersions([]);
      setSubschemas([]);
      setInstances([]);
      return () => {
        active = false;
      };
    }

    setDetailLoading(true);
    Promise.all([
      api.workflows.listVersions(selectedWorkflowId),
      api.workflows.listSubschemas(),
      api.workflows.listInstances(selectedWorkflowId)
    ])
      .then(([nextVersions, nextSubschemas, nextInstances]) => {
        if (!active) {
          return;
        }
        setVersions(nextVersions);
        setSubschemas(nextSubschemas);
        setInstances(nextInstances);
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить версии и историю Workflow."));
        }
      })
      .finally(() => {
        if (active) {
          setDetailLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, selectedWorkflowId]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [workflows, selectedWorkflowId]
  );

  async function handleToggleEnabled(workflow: Workflow) {
    setPendingWorkflowId(workflow.id);
    setAlert(null);
    setSuccess(null);

    try {
      const updated = await api.workflows.updateWorkflow(workflow.id, {
        enabled: !workflow.enabled
      });
      setWorkflows((current) => replaceWorkflow(current, updated));
      setSuccess(updated.enabled ? "Workflow включен" : "Workflow отключен");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось изменить состояние Workflow."));
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function handleActivateVersion(workflow: Workflow, versionId: string) {
    if (versionId === workflow.default_version_id) {
      return;
    }

    setPendingWorkflowId(workflow.id);
    setAlert(null);
    setSuccess(null);

    try {
      const updated = await api.workflows.updateWorkflow(workflow.id, {
        default_version_id: versionId
      });
      setWorkflows((current) => replaceWorkflow(current, updated));
      setSuccess("Активная версия обновлена. Выполняющиеся инстансы не затронуты.");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось переключить активную версию."));
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function handleVersionCreated(version: WorkflowVersion, activated: boolean) {
    setVersions((current) => [...current, version]);
    if (activated) {
      setWorkflows((current) =>
        current.map((workflow) =>
          workflow.id === version.workflow_id
            ? { ...workflow, status: "active", default_version_id: version.id }
            : workflow
        )
      );
    }
    setSuccess(
      activated
        ? `Сохранена версия v${version.version_no} и назначена активной.`
        : `Сохранена версия v${version.version_no}. Выполняющиеся инстансы не затронуты.`
    );
  }

  function handleSubschemaCreated(subschema: WorkflowSubschema) {
    setSubschemas((current) => [...current, subschema]);
  }

  function handleSubschemaSaved(subschema: WorkflowSubschema) {
    setSubschemas((current) =>
      current.some((item) => item.id === subschema.id)
        ? current.map((item) => (item.id === subschema.id ? subschema : item))
        : [...current, subschema]
    );
  }

  return (
    <section className="page-section workflow-page">
      <div className="page-heading workflow-page-heading">
        <Badge tone="neutral">Автоматизация</Badge>
        <h1>Workflow</h1>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел Workflow доступен только оператору платформы.</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canEdit ? (
        <div className="workflow-workspace">
          {loading ? <div className="route-loader">Загрузка Workflow...</div> : null}

          {selectedWorkflow && !detailLoading && versions.length > 0 ? (
            <WorkflowSchemaEditor
              instances={instances}
              key={selectedWorkflow.id}
              onActivateVersion={(versionId) =>
                void handleActivateVersion(selectedWorkflow, versionId)
              }
              onSelectWorkflow={setSelectedWorkflowId}
              onSubschemaCreated={handleSubschemaCreated}
              onSubschemaSaved={handleSubschemaSaved}
              onToggleEnabled={() => void handleToggleEnabled(selectedWorkflow)}
              onVersionCreated={handleVersionCreated}
              pending={pendingWorkflowId === selectedWorkflow.id}
              selectedWorkflowId={selectedWorkflowId}
              subschemas={subschemas}
              versions={versions}
              workflow={selectedWorkflow}
              workflows={workflows}
            />
          ) : (
            <>
              <div className="workflow-topbar">
                <WorkflowSchemeSelect
                  disabled={workflows.length === 0}
                  onSelect={setSelectedWorkflowId}
                  selectedWorkflowId={selectedWorkflowId}
                  workflows={workflows}
                />
              </div>
              {detailLoading ? (
                <div className="route-loader">Загрузка версий и истории...</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

interface WorkflowSchemeSelectProps {
  disabled?: boolean;
  onSelect: (workflowId: string) => void;
  selectedWorkflowId: string | null;
  workflows: Workflow[];
}

/** Выпадающий выбор схемы Workflow (слева в верхней панели, макет /#/schemas fbp_engine). */
function WorkflowSchemeSelect({
  disabled,
  onSelect,
  selectedWorkflowId,
  workflows
}: WorkflowSchemeSelectProps) {
  return (
    <label className="workflow-select workflow-topbar-scheme">
      <select
        aria-label="Схема Workflow"
        disabled={disabled}
        onChange={(event) => onSelect(event.currentTarget.value)}
        value={selectedWorkflowId ?? ""}
      >
        {workflows.length === 0 ? <option value="">—</option> : null}
        {workflows.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface WorkflowModalProps {
  children: ReactNode;
  onClose: () => void;
  title: string;
}

/** Лёгкое модальное окно (макет /#/schemas): затемнение + диалог, закрытие по фону и по крестику. */
function WorkflowModal({ children, onClose, title }: WorkflowModalProps) {
  return (
    <div className="workflow-modal-overlay" onClick={onClose} role="presentation">
      <div
        aria-label={title}
        aria-modal="true"
        className="workflow-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="workflow-modal-head">
          <h2>{title}</h2>
          <button
            aria-label="Закрыть"
            className="workflow-modal-close"
            onClick={onClose}
            title="Закрыть"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="workflow-modal-body">{children}</div>
      </div>
    </div>
  );
}

interface WorkflowSchemaEditorProps {
  instances: WorkflowInstance[];
  onActivateVersion: (versionId: string) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onSubschemaCreated: (subschema: WorkflowSubschema) => void;
  onSubschemaSaved: (subschema: WorkflowSubschema) => void;
  onToggleEnabled: () => void;
  onVersionCreated: (version: WorkflowVersion, activated: boolean) => void;
  pending: boolean;
  selectedWorkflowId: string | null;
  subschemas: WorkflowSubschema[];
  versions: WorkflowVersion[];
  workflow: Workflow;
  workflows: Workflow[];
}

type WorkflowTestScope = "schema" | "bodyGraph";

interface WorkflowTestLogEntry {
  id: string;
  event: string;
  message: string;
}

interface WorkflowTestRun {
  logs: WorkflowTestLogEntry[];
  scope: WorkflowTestScope;
}

/** Цель редактирования: рабочая схема Workflow или отдельная субсхема. */
type WorkflowEditTarget = { kind: "workflow" } | { kind: "subschema"; subschema: WorkflowSubschema };

function WorkflowSchemaEditor({
  instances,
  onActivateVersion,
  onSelectWorkflow,
  onSubschemaCreated,
  onSubschemaSaved,
  onToggleEnabled,
  onVersionCreated,
  pending,
  selectedWorkflowId,
  subschemas,
  versions,
  workflow,
  workflows
}: WorkflowSchemaEditorProps) {
  const api = useSaasAdminApi();
  const defaultVersion = useMemo(
    () => versions.find((version) => version.id === workflow.default_version_id) ?? versions[0],
    [versions, workflow.default_version_id]
  );
  const [editTarget, setEditTarget] = useState<WorkflowEditTarget>({ kind: "workflow" });
  const [baseVersionId, setBaseVersionId] = useState(defaultVersion.id);
  const [rootDraftSchema, setRootDraftSchema] = useState<WorkflowSchema>(() =>
    cloneDraftSchema(defaultVersion.schema)
  );
  const [bodyPath, setBodyPath] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => defaultVersion.schema.nodes[0]?.id ?? null
  );
  const [connectionFrom, setConnectionFrom] = useState("");
  const [connectionTo, setConnectionTo] = useState("");
  const [hasDraft, setHasDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [testScope, setTestScope] = useState<WorkflowTestScope>("schema");
  const [testRun, setTestRun] = useState<WorkflowTestRun | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorAlert, setEditorAlert] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [subDialogOpen, setSubDialogOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const editingSubschema = editTarget.kind === "subschema";
  const draftSchema = useMemo(
    () => getSchemaAtPath(rootDraftSchema, bodyPath),
    [bodyPath, rootDraftSchema]
  );
  const bodyPathLabels = useMemo(
    () => getBodyPathLabels(rootDraftSchema, bodyPath),
    [bodyPath, rootDraftSchema]
  );
  const validation = useMemo(() => validateWorkflowSchema(rootDraftSchema), [rootDraftSchema]);
  const selectedNode = useMemo(
    () => draftSchema.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [draftSchema.nodes, selectedNodeId]
  );
  const latestDraftRef = useRef({
    draftSaved,
    editingSubschema,
    hasDraft,
    schema: rootDraftSchema,
    valid: validation.valid,
    workflowId: workflow.id
  });

  useEffect(() => {
    latestDraftRef.current = {
      draftSaved,
      editingSubschema,
      hasDraft,
      schema: rootDraftSchema,
      valid: validation.valid,
      workflowId: workflow.id
    };
  }, [draftSaved, editingSubschema, hasDraft, rootDraftSchema, validation.valid, workflow.id]);

  useEffect(() => {
    let active = true;
    setDraftLoading(true);
    setEditorAlert(null);

    api.workflows
      .getDraft(workflow.id)
      .then((draft) => {
        if (!active) {
          return;
        }
        const nextSchema = draft.has_draft && draft.schema ? draft.schema : defaultVersion.schema;
        setEditTarget({ kind: "workflow" });
        setBaseVersionId(defaultVersion.id);
        setRootDraftSchema(cloneDraftSchema(nextSchema));
        setBodyPath([]);
        setSelectedNodeId(nextSchema.nodes[0]?.id ?? null);
        setConnectionFrom("");
        setConnectionTo("");
        setHasDraft(draft.has_draft);
        setDraftSaved(draft.has_draft);
        setDraftUpdatedAt(draft.draft_updated_at);
        setTestRun(null);
      })
      .catch((error) => {
        if (active) {
          setEditorAlert(getProblemMessage(error, "Не удалось загрузить черновик Workflow."));
        }
      })
      .finally(() => {
        if (active) {
          setDraftLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, defaultVersion.id, defaultVersion.schema, workflow.id]);

  useEffect(() => {
    return () => {
      const latest = latestDraftRef.current;
      if (
        !latest.editingSubschema &&
        latest.workflowId === workflow.id &&
        latest.hasDraft &&
        !latest.draftSaved &&
        latest.valid
      ) {
        void api.workflows.saveDraft(workflow.id, { schema: latest.schema });
      }
    };
  }, [api, workflow.id]);

  function updateActiveSchema(updater: (schema: WorkflowSchema) => WorkflowSchema) {
    setRootDraftSchema((current) => updateSchemaAtPath(current, bodyPath, updater));
    setHasDraft(true);
    setDraftSaved(false);
    setTestRun(null);
    setEditorAlert(null);
    setEditorNotice(null);
  }

  function handleAddNode(type: WorkflowNodeType, position?: WorkflowNode["position"]) {
    const node = createWorkflowNode(type, draftSchema.nodes, position);
    updateActiveSchema((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
  }

  function handleUpdateNodeLabel(nodeId: string, label: string) {
    updateActiveSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, label } : node))
    }));
  }

  function handleUpdateNodeConfig(nodeId: string, key: string, value: string) {
    updateActiveSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, config: { ...node.config, [key]: value } } : node
      )
    }));
  }

  function handleDeleteNode(nodeId: string) {
    updateActiveSchema((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      connections: current.connections.filter(
        (connection) => connection.from !== nodeId && connection.to !== nodeId
      )
    }));
    setSelectedNodeId((current) => (current === nodeId ? null : current));
  }

  function handleAddConnection() {
    if (!connectionFrom || !connectionTo || connectionFrom === connectionTo) {
      return;
    }
    updateActiveSchema((current) => ({
      ...current,
      connections: [
        ...current.connections,
        createWorkflowConnection(connectionFrom, connectionTo, current.connections)
      ]
    }));
    setConnectionFrom("");
    setConnectionTo("");
  }

  function handleDeleteConnection(connectionId: string) {
    updateActiveSchema((current) => ({
      ...current,
      connections: current.connections.filter((connection) => connection.id !== connectionId)
    }));
  }

  function handleMoveNode(nodeId: string, position: WorkflowNode["position"]) {
    updateActiveSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node))
    }));
  }

  function handleOpenBodyGraph() {
    if (!selectedNode || !workflowNodeSupportsBodyGraph(selectedNode.type)) {
      return;
    }

    const bodyGraph = getNodeBodyGraph(selectedNode);
    updateActiveSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selectedNode.id
          ? {
              ...node,
              config: {
                ...node.config,
                [WORKFLOW_BODY_GRAPH_CONFIG_KEY]: bodyGraph
              }
            }
          : node
      )
    }));
    setBodyPath((current) => [...current, selectedNode.id]);
    setSelectedNodeId(bodyGraph.nodes[0]?.id ?? null);
    setConnectionFrom("");
    setConnectionTo("");
  }

  function handleExitBodyGraph() {
    const parentNodeId = bodyPath.at(-1) ?? null;
    setBodyPath((current) => current.slice(0, -1));
    setSelectedNodeId(parentNodeId);
    setConnectionFrom("");
    setConnectionTo("");
  }

  async function persistDraft(notice: string | null = "Черновик сохранён."): Promise<boolean> {
    if (!validation.valid) {
      setEditorAlert("Исправьте ошибки схемы перед сохранением черновика.");
      return false;
    }

    setSaving(true);
    setEditorAlert(null);

    try {
      const draft = await api.workflows.saveDraft(workflow.id, { schema: rootDraftSchema });
      if (draft.schema) {
        setRootDraftSchema(cloneDraftSchema(draft.schema));
        const selectedNodeStillExists = draft.schema.nodes.some((node) => node.id === selectedNodeId);
        setSelectedNodeId(selectedNodeStillExists ? selectedNodeId : draft.schema.nodes[0]?.id ?? null);
      }
      setHasDraft(true);
      setDraftSaved(true);
      setDraftUpdatedAt(draft.draft_updated_at);
      if (notice !== null) {
        setEditorNotice(notice);
      }
      return true;
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось сохранить черновик."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Перезагрузка черновика из рабочей версии (или субсхемы) — иконка тулбара. */
  async function handleReload() {
    if (editTarget.kind === "subschema") {
      setRootDraftSchema(cloneDraftSchema(editTarget.subschema.schema));
      setBodyPath([]);
      setSelectedNodeId(editTarget.subschema.schema.nodes[0]?.id ?? null);
      setHasDraft(false);
      setDraftSaved(true);
      setTestRun(null);
      setEditorAlert(null);
      setEditorNotice("Схема субсхемы перезагружена из сохранённой версии.");
      return;
    }

    const base = versions.find((version) => version.id === workflow.default_version_id) ?? defaultVersion;
    if (!base) {
      return;
    }

    setSaving(true);
    setEditorAlert(null);
    setEditorNotice(null);

    try {
      await api.workflows.resetDraft(workflow.id);
      setRootDraftSchema(cloneDraftSchema(base.schema));
      setBaseVersionId(base.id);
      setBodyPath([]);
      setSelectedNodeId(base.schema.nodes[0]?.id ?? null);
      setHasDraft(false);
      setDraftSaved(false);
      setDraftUpdatedAt(null);
      setTestRun(null);
      setEditorNotice(`Черновик перезагружен из рабочей версии v${base.version_no}.`);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось перезагрузить черновик."));
    } finally {
      setSaving(false);
    }
  }

  /** Сохранить черновик в рабочую версию — иконка тулбара (promote / updateSubschema). */
  async function handleSaveToWorking() {
    if (!validation.valid) {
      setEditorAlert("Исправьте ошибки схемы перед сохранением.");
      return;
    }

    if (editTarget.kind === "subschema") {
      setSaving(true);
      setEditorAlert(null);
      try {
        const updated = await api.workflows.updateSubschema(editTarget.subschema.id, {
          schema: rootDraftSchema
        });
        onSubschemaSaved(updated);
        setEditTarget({ kind: "subschema", subschema: updated });
        setRootDraftSchema(cloneDraftSchema(updated.schema));
        setHasDraft(false);
        setDraftSaved(true);
        setTestRun(null);
        setEditorNotice(`Субсхема «${updated.name}» сохранена.`);
      } catch (error) {
        setEditorAlert(getProblemMessage(error, "Не удалось сохранить субсхему."));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!draftSaved) {
      const saved = await persistDraft(null);
      if (!saved) {
        return;
      }
    }

    setSaving(true);
    setEditorAlert(null);

    try {
      const version = await api.workflows.promoteDraft(workflow.id);
      onVersionCreated(version, true);
      setBaseVersionId(version.id);
      setRootDraftSchema(cloneDraftSchema(version.schema));
      setBodyPath([]);
      setSelectedNodeId(version.schema.nodes[0]?.id ?? null);
      setHasDraft(false);
      setDraftSaved(false);
      setDraftUpdatedAt(null);
      setTestRun(null);
      setEditorNotice("Черновик сохранён в рабочую версию.");
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось сохранить черновик в рабочую версию."));
    } finally {
      setSaving(false);
    }
  }

  async function handleExportWorkflow() {
    setSaving(true);
    setEditorAlert(null);
    setEditorNotice(null);

    try {
      if (editTarget.kind === "subschema") {
        downloadWorkflowExport(buildSubschemaExport(editTarget.subschema, rootDraftSchema));
        setEditorNotice(`Экспортирована субсхема «${editTarget.subschema.name}».`);
      } else {
        const exported = await api.workflows.exportWorkflow(workflow.id);
        downloadWorkflowExport(exported);
        setEditorNotice(`Экспортирована активная версия v${exported.workflow.version_no}.`);
      }
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось экспортировать JSON."));
    } finally {
      setSaving(false);
    }
  }

  function handleImportClick() {
    importInputRef.current?.click();
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    setSaving(true);
    setEditorAlert(null);
    setEditorNotice(null);

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const payload = normalizeWorkflowImportPayload(parsed, workflow, defaultVersion);
      const importValidation = validateWorkflowSchema(payload.schema);
      if (!importValidation.valid) {
        setEditorAlert(`Файл импорта не прошёл проверку: ${importValidation.errors.join(" ")}`);
        return;
      }

      const diffSummary = summarizeWorkflowSchemaDiff(rootDraftSchema, payload.schema);
      const targetLabel = editTarget.kind === "subschema" ? "субсхему" : "черновик";
      const confirmed = window.confirm(`Импортировать JSON как ${targetLabel}?\n${diffSummary}`);
      if (!confirmed) {
        return;
      }

      if (editTarget.kind === "subschema") {
        setRootDraftSchema(cloneDraftSchema(payload.schema));
        setBodyPath([]);
        setSelectedNodeId(payload.schema.nodes[0]?.id ?? null);
        setConnectionFrom("");
        setConnectionTo("");
        setHasDraft(true);
        setDraftSaved(false);
        setTestRun(null);
        setEditorNotice("JSON загружен в редактор субсхемы. Сохраните, чтобы применить.");
        return;
      }

      const imported = await api.workflows.importWorkflow(workflow.id, {
        ...payload,
        target: "draft"
      });

      const importedSchema = imported.draft?.schema;
      if (!importedSchema) {
        throw new Error("Workflow import did not return a schema.");
      }

      setRootDraftSchema(cloneDraftSchema(importedSchema));
      setBaseVersionId(defaultVersion.id);
      setBodyPath([]);
      setSelectedNodeId(importedSchema.nodes[0]?.id ?? null);
      setConnectionFrom("");
      setConnectionTo("");
      setHasDraft(true);
      setDraftSaved(true);
      setDraftUpdatedAt(imported.draft?.draft_updated_at ?? null);
      setTestRun(null);
      setEditorNotice("JSON импортирован и сохранён как черновик.");
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось импортировать JSON."));
    } finally {
      setSaving(false);
    }
  }

  async function handleRunTest() {
    if (editTarget.kind === "workflow" && hasDraft && !draftSaved) {
      const saved = await persistDraft("Черновик автосохранён перед тестовым запуском.");
      if (!saved) {
        return;
      }
    }
    setTestRun(simulateWorkflowTest(rootDraftSchema, testScope));
    setEditorAlert(null);
    setEditorNotice("Тестовый запуск завершён.");
  }

  async function handleCreateSubschema(slug: string, name: string) {
    setSaving(true);
    setEditorAlert(null);

    try {
      // Сохраняем черновик рабочей схемы, чтобы не потерять правки при переходе.
      if (editTarget.kind === "workflow" && hasDraft && !draftSaved && validation.valid) {
        await persistDraft(null);
      }

      const subschema = await api.workflows.createSubschema({ slug, name });
      onSubschemaCreated(subschema);
      setSubDialogOpen(false);
      setEditTarget({ kind: "subschema", subschema });
      setRootDraftSchema(cloneDraftSchema(subschema.schema));
      setBodyPath([]);
      setSelectedNodeId(subschema.schema.nodes[0]?.id ?? null);
      setConnectionFrom("");
      setConnectionTo("");
      setHasDraft(false);
      setDraftSaved(true);
      setTestRun(null);
      setHistoryOpen(false);
      setEditorNotice(`Субсхема «${name}» создана. Отредактируйте её и сохраните.`);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось создать субсхему."));
    } finally {
      setSaving(false);
    }
  }

  async function handleBackToWorkflow() {
    if (editTarget.kind !== "subschema") {
      return;
    }
    if (hasDraft && !draftSaved && validation.valid) {
      try {
        const updated = await api.workflows.updateSubschema(editTarget.subschema.id, {
          schema: rootDraftSchema
        });
        onSubschemaSaved(updated);
      } catch (error) {
        setEditorAlert(getProblemMessage(error, "Не удалось сохранить субсхему перед выходом."));
        return;
      }
    }

    setEditTarget({ kind: "workflow" });
    setTestRun(null);
    setEditorAlert(null);
    setEditorNotice(null);

    const draft = await api.workflows.getDraft(workflow.id).catch(() => null);
    const nextSchema = draft?.has_draft && draft.schema ? draft.schema : defaultVersion.schema;
    setBaseVersionId(defaultVersion.id);
    setRootDraftSchema(cloneDraftSchema(nextSchema));
    setBodyPath([]);
    setSelectedNodeId(nextSchema.nodes[0]?.id ?? null);
    setConnectionFrom("");
    setConnectionTo("");
    setHasDraft(Boolean(draft?.has_draft));
    setDraftSaved(Boolean(draft?.has_draft));
    setDraftUpdatedAt(draft?.draft_updated_at ?? null);
  }

  const schemeTitle = editingSubschema ? editTarget.subschema.name : workflow.name;
  const draftStatusText = editingSubschema
    ? hasDraft
      ? "Есть несохранённые изменения субсхемы"
      : "Субсхема сохранена"
    : hasDraft
      ? "Есть незафиксированный черновик"
      : "Черновик совпадает с рабочей версией";

  return (
    <section aria-label="Редактор схемы Workflow" className="workflow-editor">
      <div className="workflow-topbar">
        {editingSubschema ? (
          <div className="workflow-topbar-scheme workflow-subschema-heading">
            <Button onClick={() => void handleBackToWorkflow()} type="button" variant="secondary">
              <ArrowLeft aria-hidden="true" size={16} />
              Вернуться к Workflow
            </Button>
            <span className="workflow-subschema-name">Субсхема: {editTarget.subschema.name}</span>
          </div>
        ) : (
          <WorkflowSchemeSelect
            disabled={saving || workflows.length === 0}
            onSelect={onSelectWorkflow}
            selectedWorkflowId={selectedWorkflowId}
            workflows={workflows}
          />
        )}

        <div aria-label="Действия со схемой" className="workflow-toolbar" role="toolbar">
          <span
            className={`workflow-draft-status ${hasDraft ? "has-draft" : ""}`}
            title={draftStatusText}
          >
            <ShieldCheck aria-hidden="true" size={16} />
            <span className="workflow-draft-status-text">{draftStatusText}</span>
          </span>

          <Button
            aria-label="Перезагрузить черновик из рабочей версии"
            className="workflow-toolbar-button"
            disabled={saving || draftLoading}
            onClick={() => void handleReload()}
            title="Перезагрузить черновик из рабочей версии"
            type="button"
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" size={18} />
          </Button>
          <Button
            aria-label="Создать субсхему"
            className="workflow-toolbar-button"
            disabled={saving || draftLoading}
            onClick={() => setSubDialogOpen(true)}
            title="Создать субсхему"
            type="button"
            variant="ghost"
          >
            <Plus aria-hidden="true" size={18} />
          </Button>
          <Button
            aria-label="Сохранить черновик в рабочую версию"
            className="workflow-toolbar-button"
            disabled={saving || draftLoading || !validation.valid}
            onClick={() => void handleSaveToWorking()}
            title="Сохранить черновик в рабочую версию"
            type="button"
            variant="ghost"
          >
            <UploadCloud aria-hidden="true" size={18} />
          </Button>
          <Button
            aria-label="Экспорт JSON"
            className="workflow-toolbar-button"
            disabled={saving || draftLoading}
            onClick={() => void handleExportWorkflow()}
            title="Экспорт JSON"
            type="button"
            variant="ghost"
          >
            <Download aria-hidden="true" size={18} />
          </Button>
          <Button
            aria-label="Импорт JSON"
            className="workflow-toolbar-button"
            disabled={saving || draftLoading}
            onClick={handleImportClick}
            title="Импорт JSON"
            type="button"
            variant="ghost"
          >
            <FileUp aria-hidden="true" size={18} />
          </Button>
          <input
            accept="application/json,.json"
            aria-label="Файл импорта Workflow JSON"
            onChange={(event) => void handleImportFile(event)}
            ref={importInputRef}
            style={{ display: "none" }}
            type="file"
          />
          <Button
            aria-label="История исполнения"
            aria-pressed={historyOpen}
            className="workflow-toolbar-button"
            disabled={editingSubschema}
            onClick={() => setHistoryOpen(true)}
            title="История исполнения"
            type="button"
            variant="ghost"
          >
            <History aria-hidden="true" size={18} />
          </Button>
          <Button
            aria-label="Тестовый запуск"
            className="workflow-toolbar-button"
            onClick={() => setTestOpen(true)}
            title="Тестовый запуск"
            type="button"
            variant="ghost"
          >
            <FlaskConical aria-hidden="true" size={18} />
          </Button>
        </div>
      </div>

      {editorAlert ? (
        <div className="form-alert" role="alert">
          {editorAlert}
        </div>
      ) : null}

      {editorNotice ? <div className="form-success">{editorNotice}</div> : null}

      {draftLoading ? <div className="route-loader">Загрузка черновика...</div> : null}

      <div className="workflow-editor-grid">
        <div className="workflow-palette" aria-label="Палитра узлов">
          <div className="workflow-schema-info">
            <div className="workflow-schema-meta">
              <h2 className="workflow-schema-name">{schemeTitle}</h2>
              <div className="workflow-topbar-tags">
                {editingSubschema ? (
                  <Badge tone="neutral">Субсхема</Badge>
                ) : (
                  <>
                    <Badge tone={workflowStatusTone(workflow.status)}>
                      {workflowStatusLabel(workflow.status)}
                    </Badge>
                    <Badge tone={workflow.enabled ? "success" : "neutral"}>
                      {workflow.enabled ? "Включен" : "Отключен"}
                    </Badge>
                  </>
                )}
              </div>
            </div>
            <h3>Информация о схеме</h3>

            {editingSubschema ? (
              <p className="muted">Слаг: {editTarget.subschema.slug}</p>
            ) : (
              <>
                <Button
                  className="workflow-schema-toggle"
                  disabled={pending}
                  onClick={onToggleEnabled}
                  type="button"
                  variant="secondary"
                >
                  <Power aria-hidden="true" size={16} />
                  {workflow.enabled ? "Отключить" : "Включить"}
                </Button>
                <label className="workflow-select">
                  <span>Активная версия по умолчанию</span>
                  <select
                    disabled={pending || versions.length === 0}
                    onChange={(event) => onActivateVersion(event.currentTarget.value)}
                    value={workflow.default_version_id}
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version_no} · {version.created_at}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">Обновлён {workflow.updated_at}</p>
              </>
            )}

            {draftUpdatedAt ? <p className="muted">Черновик сохранён {draftUpdatedAt}</p> : null}

            {validation.errors.length > 0 ? (
              <ul className="workflow-validation" aria-label="Ошибки валидации схемы">
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : (
              <p className="workflow-validation-ok">
                <ShieldCheck aria-hidden="true" size={16} />
                Схема соответствует безопасному набору узлов.
              </p>
            )}
          </div>

          <h3>Палитра узлов</h3>
          <p className="muted workflow-palette-hint">
            Перетащите узел на холст, чтобы добавить его в схему (ТЗ §13.13).
          </p>
          {SAFE_WORKFLOW_NODE_TYPES.map((type) => (
            <button
              aria-label={`Добавить узел: ${workflowNodeTypeLabel(type)}`}
              className={`workflow-palette-item ${workflowNodeMutatesData(type) ? "mutating" : ""}`}
              draggable
              key={type}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(NODE_DND_MIME, type);
              }}
              type="button"
            >
              <span className="workflow-palette-item-title">
                {workflowNodeMutatesData(type) ? (
                  <Database aria-hidden="true" size={14} />
                ) : (
                  <Plus aria-hidden="true" size={14} />
                )}
                {workflowNodeTypeLabel(type)}
              </span>
              <span className="muted">{workflowNodeTypeDescription(type)}</span>
            </button>
          ))}
        </div>

        <div className="workflow-graph-column">
          <div className="workflow-graph-breadcrumb" aria-label="Текущий граф">
            <Boxes aria-hidden="true" size={16} />
            <span>
              {[editingSubschema ? "Субсхема" : "Корневая схема", ...bodyPathLabels].join(" / ")}
            </span>
            {bodyPath.length > 0 ? (
              <Button onClick={handleExitBodyGraph} type="button" variant="secondary">
                <ArrowLeft aria-hidden="true" size={16} />
                Вернуться к родительской схеме
              </Button>
            ) : null}
          </div>

          <WorkflowCanvas
            connections={draftSchema.connections}
            key={bodyPath.join("/") || (editingSubschema ? editTarget.subschema.id : baseVersionId)}
            nodes={draftSchema.nodes}
            onDropNode={handleAddNode}
            onMoveNode={handleMoveNode}
            onSelectNode={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
          />
        </div>

        <div className="workflow-side-panel" aria-label="Свойства и связи узлов">
          <WorkflowNodeProperties
            node={selectedNode}
            onDeleteNode={handleDeleteNode}
            onOpenBodyGraph={handleOpenBodyGraph}
            onUpdateConfig={handleUpdateNodeConfig}
            onUpdateLabel={handleUpdateNodeLabel}
            subschemas={subschemas}
          />

          <WorkflowConnectionsEditor
            connectionFrom={connectionFrom}
            connectionTo={connectionTo}
            connections={draftSchema.connections}
            nodes={draftSchema.nodes}
            onAddConnection={handleAddConnection}
            onDeleteConnection={handleDeleteConnection}
            onFromChange={setConnectionFrom}
            onToChange={setConnectionTo}
          />
        </div>
      </div>

      {subDialogOpen ? (
        <WorkflowNewSubschemaModal
          existingSlugs={subschemas.map((item) => item.slug)}
          onClose={() => setSubDialogOpen(false)}
          onCreateSubschema={(slug, name) => void handleCreateSubschema(slug, name)}
          saving={saving}
        />
      ) : null}

      {testOpen ? (
        <WorkflowModal onClose={() => setTestOpen(false)} title="Тестовый запуск">
          <div className="workflow-test-controls">
            <label className="workflow-select">
              <span>Область теста</span>
              <select
                onChange={(event) => setTestScope(event.currentTarget.value as WorkflowTestScope)}
                value={testScope}
              >
                <option value="schema">Схема</option>
                <option value="bodyGraph">Текущая bodyGraph</option>
              </select>
            </label>
            <Button disabled={!validation.valid} onClick={() => void handleRunTest()} type="button">
              <FlaskConical aria-hidden="true" size={16} />
              Запустить тест
            </Button>
          </div>

          {testRun ? (
            <div className="workflow-test-log" role="region" aria-label="Лог тестового запуска">
              <div className="workflow-test-log-heading">
                <Badge tone="success">{workflowTestScopeLabel(testRun.scope)}</Badge>
                <span className="muted">Детерминированный dry-run без мутаций данных.</span>
              </div>
              <ol className="workflow-log">
                {testRun.logs.map((entry) => (
                  <li key={entry.id}>
                    <span className="workflow-log-event">{entry.event}</span>
                    <span className="workflow-log-message">{entry.message}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="muted">Запустите тест, чтобы увидеть детерминированный лог dry-run.</p>
          )}
        </WorkflowModal>
      ) : null}

      {historyOpen && !editingSubschema ? (
        <WorkflowModal onClose={() => setHistoryOpen(false)} title="История исполнения">
          <WorkflowInstancesPanel instances={instances} workflowId={workflow.id} />
        </WorkflowModal>
      ) : null}
    </section>
  );
}

interface WorkflowNewSubschemaModalProps {
  existingSlugs: string[];
  onClose: () => void;
  onCreateSubschema: (slug: string, name: string) => void;
  saving: boolean;
}

const WORKFLOW_SUBSCHEMA_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function WorkflowNewSubschemaModal({
  existingSlugs,
  onClose,
  onCreateSubschema,
  saving
}: WorkflowNewSubschemaModalProps) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedSlug = slug.trim();
    const trimmedName = name.trim();
    if (!WORKFLOW_SUBSCHEMA_SLUG_PATTERN.test(trimmedSlug)) {
      setError("Slug: латиница, цифры, дефис или подчёркивание (1–100 символов).");
      return;
    }
    if (existingSlugs.includes(trimmedSlug)) {
      setError("Субсхема с таким slug уже существует.");
      return;
    }
    if (!trimmedName) {
      setError("Укажите название субсхемы.");
      return;
    }
    setError(null);
    onCreateSubschema(trimmedSlug, trimmedName);
  }

  return (
    <WorkflowModal onClose={onClose} title="Создать субсхему">
      <form className="workflow-subschema-form" onSubmit={handleSubmit}>
        <TextInput
          autoFocus
          id="workflow-subschema-slug"
          label="Slug (имя схемы)"
          onChange={(event) => setSlug(event.currentTarget.value)}
          placeholder="my-sub-schema"
          value={slug}
        />
        <TextInput
          id="workflow-subschema-name"
          label="Название"
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Общий контекст"
          value={name}
        />
        <p className="muted">
          Субсхема создаётся отдельной сущностью; после создания откроется её редактор.
        </p>
        {error ? (
          <div className="form-alert" role="alert">
            {error}
          </div>
        ) : null}
        <Button disabled={saving} type="submit">
          <Plus aria-hidden="true" size={16} />
          Создать
        </Button>
      </form>
    </WorkflowModal>
  );
}

interface WorkflowCanvasProps {
  connections: WorkflowSchema["connections"];
  nodes: WorkflowNode[];
  onDropNode: (type: WorkflowNodeType, position: WorkflowNode["position"]) => void;
  onMoveNode: (nodeId: string, position: WorkflowNode["position"]) => void;
  onSelectNode: (nodeId: string) => void;
  selectedNodeId: string | null;
}

const NODE_DND_MIME = "application/x-bridge-workflow-node";
const NODE_MOVE_DND_MIME = "application/x-bridge-workflow-node-id";
const NODE_WIDTH = 176;
const NODE_HEIGHT = 68;

const CANVAS_MIN_SCALE = 0.5;
const CANVAS_MAX_SCALE = 2;
const CANVAS_SCALE_STEP = 0.1;

function clampCanvasScale(scale: number): number {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, Math.round(scale * 100) / 100));
}

function WorkflowCanvas({
  connections,
  nodes,
  onDropNode,
  onMoveNode,
  onSelectNode,
  selectedNodeId
}: WorkflowCanvasProps) {
  const width = Math.max(480, ...nodes.map((node) => node.position.x + NODE_WIDTH + 40));
  const height = Math.max(280, ...nodes.map((node) => node.position.y + NODE_HEIGHT + 40));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const [scale, setScale] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Масштабирование колесом мыши (ТЗ §13 — макет fbp_engine). Нативный слушатель с
  // passive:false нужен, чтобы предотвратить прокрутку страницы во время зума.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) {
      return;
    }

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setScale((current) => clampCanvasScale(current + direction * CANVAS_SCALE_STEP));
    }

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (
      event.dataTransfer.types.includes(NODE_DND_MIME) ||
      event.dataTransfer.types.includes(NODE_MOVE_DND_MIME)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes(NODE_MOVE_DND_MIME)
        ? "move"
        : "copy";
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    const type = event.dataTransfer.getData(NODE_DND_MIME) as WorkflowNodeType;
    const nodeId = event.dataTransfer.getData(NODE_MOVE_DND_MIME);
    if (!type && !nodeId) {
      return;
    }

    event.preventDefault();
    const position = workflowDropPosition(event, scale);
    if (nodeId) {
      onMoveNode(nodeId, position);
      onSelectNode(nodeId);
      return;
    }

    if (SAFE_WORKFLOW_NODE_TYPES.includes(type)) {
      onDropNode(type, position);
    }
  }

  return (
    <div
      className="workflow-canvas"
      aria-label="Схема узлов и связей"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      ref={canvasRef}
      role="group"
    >
      <div className="workflow-canvas-toolbar" aria-label="Масштаб холста">
        <button
          aria-label="Уменьшить масштаб"
          className="workflow-zoom-button"
          onClick={() => setScale((current) => clampCanvasScale(current - CANVAS_SCALE_STEP))}
          type="button"
        >
          <ZoomOut aria-hidden="true" size={16} />
        </button>
        <span className="workflow-zoom-value">{Math.round(scale * 100)}%</span>
        <button
          aria-label="Увеличить масштаб"
          className="workflow-zoom-button"
          onClick={() => setScale((current) => clampCanvasScale(current + CANVAS_SCALE_STEP))}
          type="button"
        >
          <ZoomIn aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Сбросить масштаб"
          className="workflow-zoom-button"
          onClick={() => setScale(1)}
          type="button"
        >
          100%
        </button>
      </div>
      <div
        className="workflow-canvas-surface"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}
      >
        <svg aria-hidden="true" className="workflow-canvas-edges" height={height} width={width}>
          <defs>
            <marker
              id="workflow-arrow"
              markerHeight="6"
              markerWidth="6"
              orient="auto"
              refX="5"
              refY="3"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
            </marker>
          </defs>
          {connections.map((connection) => {
            const from = nodeById.get(connection.from);
            const to = nodeById.get(connection.to);
            if (!from || !to) {
              return null;
            }
            return (
              <line
                key={connection.id}
                markerEnd="url(#workflow-arrow)"
                x1={from.position.x + NODE_WIDTH}
                x2={to.position.x}
                y1={from.position.y + NODE_HEIGHT / 2}
                y2={to.position.y + NODE_HEIGHT / 2}
              />
            );
          })}
        </svg>
        {nodes.map((node) => (
          <button
            aria-label={`Узел ${node.label}`}
            aria-pressed={node.id === selectedNodeId}
            className={`workflow-node ${node.id === selectedNodeId ? "selected" : ""} ${
              workflowNodeMutatesData(node.type) ? "mutating" : ""
            }`}
            draggable
            key={node.id}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(NODE_MOVE_DND_MIME, node.id);
            }}
            onClick={() => onSelectNode(node.id)}
            style={{ left: node.position.x, top: node.position.y, width: NODE_WIDTH }}
            type="button"
          >
            <span className="workflow-node-type">{workflowNodeTypeLabel(node.type)}</span>
            <span className="workflow-node-label">{node.label}</span>
            {workflowNodeMutatesData(node.type) ? (
              <span className="workflow-node-flag">
                <Database aria-hidden="true" size={12} />
                Backend API
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function workflowDropPosition(
  event: DragEvent<HTMLDivElement>,
  scale = 1
): WorkflowNode["position"] {
  const rect = event.currentTarget.getBoundingClientRect();
  const clientX = Number.isFinite(event.clientX) ? event.clientX : rect.left + 180;
  const clientY = Number.isFinite(event.clientY) ? event.clientY : rect.top + 140;
  const scrollLeft = Number.isFinite(event.currentTarget.scrollLeft)
    ? event.currentTarget.scrollLeft
    : 0;
  const scrollTop = Number.isFinite(event.currentTarget.scrollTop)
    ? event.currentTarget.scrollTop
    : 0;
  const safeScale = scale > 0 ? scale : 1;

  return {
    x: Math.max(20, Math.round((clientX - rect.left + scrollLeft) / safeScale - NODE_WIDTH / 2)),
    y: Math.max(20, Math.round((clientY - rect.top + scrollTop) / safeScale - NODE_HEIGHT / 2))
  };
}

interface WorkflowNodePropertiesProps {
  node: WorkflowNode | null;
  onDeleteNode: (nodeId: string) => void;
  onOpenBodyGraph: () => void;
  onUpdateConfig: (nodeId: string, key: string, value: string) => void;
  onUpdateLabel: (nodeId: string, label: string) => void;
  subschemas: WorkflowSubschema[];
}

function WorkflowNodeProperties({
  node,
  onDeleteNode,
  onOpenBodyGraph,
  onUpdateConfig,
  onUpdateLabel,
  subschemas
}: WorkflowNodePropertiesProps) {
  if (!node) {
    return (
      <div className="workflow-properties" aria-label="Свойства узла">
        <h3>Свойства узла</h3>
        <p className="muted">Выберите узел на схеме, чтобы отредактировать его параметры.</p>
      </div>
    );
  }

  const primary = workflowNodePrimaryField(node.type);
  const mutates = workflowNodeMutatesData(node.type);

  return (
    <div className="workflow-properties" aria-label="Свойства узла">
      <div className="workflow-properties-heading">
        <h3>Свойства узла</h3>
        <Badge tone={mutates ? "warning" : "neutral"}>
          {mutates ? "Изменяет данные" : "Только чтение"}
        </Badge>
      </div>
      <p className="muted">{workflowNodeTypeDescription(node.type)}</p>
      <TextInput
        id={`workflow-node-label-${node.id}`}
        label="Метка узла"
        onChange={(event) => onUpdateLabel(node.id, event.currentTarget.value)}
        value={node.label}
      />
      {node.type === "sub_schema" ? (
        <label className="workflow-select" htmlFor={`workflow-node-subSchemaSlug-${node.id}`}>
          <span>{primary.label}</span>
          <select
            id={`workflow-node-subSchemaSlug-${node.id}`}
            onChange={(event) => onUpdateConfig(node.id, "subSchemaSlug", event.currentTarget.value)}
            value={nodePrimaryValue(node, "subSchemaSlug")}
          >
            <option value="">—</option>
            {subschemas.map((subschema) => (
              <option key={subschema.id} value={subschema.slug}>
                {subschema.name} · {subschema.slug}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <TextInput
          id={`workflow-node-${primary.key}-${node.id}`}
          label={primary.label}
          onChange={(event) => onUpdateConfig(node.id, primary.key, event.currentTarget.value)}
          placeholder={primary.placeholder}
          value={nodePrimaryValue(node, primary.key)}
        />
      )}
      {workflowNodeSupportsBodyGraph(node.type) ? (
        <Button onClick={onOpenBodyGraph} type="button" variant="secondary">
          <Boxes aria-hidden="true" size={16} />
          Открыть bodyGraph
        </Button>
      ) : null}
      <Button onClick={() => onDeleteNode(node.id)} type="button" variant="ghost">
        <Trash2 aria-hidden="true" size={16} />
        Удалить узел
      </Button>
    </div>
  );
}

interface WorkflowConnectionsEditorProps {
  connectionFrom: string;
  connectionTo: string;
  connections: WorkflowSchema["connections"];
  nodes: WorkflowNode[];
  onAddConnection: () => void;
  onDeleteConnection: (connectionId: string) => void;
  onFromChange: (nodeId: string) => void;
  onToChange: (nodeId: string) => void;
}

function WorkflowConnectionsEditor({
  connectionFrom,
  connectionTo,
  connections,
  nodes,
  onAddConnection,
  onDeleteConnection,
  onFromChange,
  onToChange
}: WorkflowConnectionsEditorProps) {
  const labelByNodeId = new Map(nodes.map((node) => [node.id, node.label] as const));

  return (
    <div className="workflow-connections" aria-label="Связи узлов">
      <h3>
        <Link2 aria-hidden="true" size={16} />
        Связи узлов
      </h3>
      <div className="workflow-connection-form">
        <label className="workflow-select">
          <span>Из узла</span>
          <select
            onChange={(event) => onFromChange(event.currentTarget.value)}
            value={connectionFrom}
          >
            <option value="">—</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <label className="workflow-select">
          <span>В узел</span>
          <select onChange={(event) => onToChange(event.currentTarget.value)} value={connectionTo}>
            <option value="">—</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!connectionFrom || !connectionTo || connectionFrom === connectionTo}
          onClick={onAddConnection}
          type="button"
          variant="secondary"
        >
          <Plus aria-hidden="true" size={16} />
          Добавить связь
        </Button>
      </div>
      {connections.length > 0 ? (
        <ul className="workflow-connection-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <span>
                {labelByNodeId.get(connection.from) ?? connection.from}
                {" → "}
                {labelByNodeId.get(connection.to) ?? connection.to}
              </span>
              <button
                aria-label={`Удалить связь ${connection.id}`}
                className="workflow-connection-remove"
                onClick={() => onDeleteConnection(connection.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Связи ещё не заданы.</p>
      )}
    </div>
  );
}

interface WorkflowInstancesPanelProps {
  instances: WorkflowInstance[];
  workflowId: string;
}

function WorkflowInstancesPanel({ instances, workflowId }: WorkflowInstancesPanelProps) {
  const api = useSaasAdminApi();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowInstanceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailAlert, setDetailAlert] = useState<string | null>(null);

  async function handleOpenInstance(instanceId: string) {
    setSelectedInstanceId(instanceId);
    setLoadingDetail(true);
    setDetailAlert(null);

    try {
      const nextDetail = await api.workflows.getInstance(workflowId, instanceId);
      setDetail(nextDetail);
    } catch (error) {
      setDetail(null);
      setDetailAlert(getProblemMessage(error, "Не удалось загрузить диагностику инстанса."));
    } finally {
      setLoadingDetail(false);
    }
  }

  return (
    <div aria-label="История исполнения Workflow" className="workflow-instances" role="region">
      <p className="muted">Просмотр запусков и диагностики (без влияния на активные инстансы).</p>

      {instances.length === 0 ? (
        <p className="muted">Инстансов ещё не было.</p>
      ) : (
        <ul className="workflow-instance-list">
          {instances.map((instance) => (
            <li
              className={`workflow-instance-item ${
                instance.id === selectedInstanceId ? "selected" : ""
              }`}
              key={instance.id}
            >
              <button
                aria-label={`Диагностика инстанса ${instance.id}`}
                className="workflow-instance-select"
                onClick={() => void handleOpenInstance(instance.id)}
                type="button"
              >
                <span className="workflow-instance-title">
                  <Play aria-hidden="true" size={14} />
                  {instance.id}
                </span>
                <span className="muted">v{instance.version_no}</span>
                <Badge tone={workflowInstanceStatusTone(instance.status)}>
                  {workflowInstanceStatusLabel(instance.status)}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detailAlert ? (
        <div className="form-alert" role="alert">
          {detailAlert}
        </div>
      ) : null}

      {loadingDetail ? <div className="route-loader">Загрузка диагностики...</div> : null}

      {detail && !loadingDetail ? (
        <div className="workflow-instance-detail" aria-label={`Диагностика ${detail.id}`}>
          <dl className="metadata-list">
            <div>
              <dt>Статус</dt>
              <dd>{workflowInstanceStatusLabel(detail.status)}</dd>
            </div>
            <div>
              <dt>Запущен</dt>
              <dd>{detail.started_at ?? "—"}</dd>
            </div>
            <div>
              <dt>Завершён</dt>
              <dd>{detail.finished_at ?? "—"}</dd>
            </div>
          </dl>
          <ol className="workflow-log">
            {detail.logs.map((entry) => (
              <li key={entry.id}>
                <span className="workflow-log-event">{entry.event}</span>
                <span className="workflow-log-message">{entry.message}</span>
                <span className="muted">{entry.created_at}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function cloneDraftSchema(schema: WorkflowSchema): WorkflowSchema {
  return {
    ...schema,
    nodes: schema.nodes.map((node) => ({
      ...node,
      config: cloneNodeConfig(node.config),
      position: { ...node.position }
    })),
    connections: schema.connections.map((connection) => ({ ...connection }))
  };
}

function cloneNodeConfig(config: WorkflowNode["config"]): WorkflowNode["config"] {
  const cloned: WorkflowNode["config"] = { ...config };
  const bodyGraph = config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
  if (isWorkflowSchema(bodyGraph)) {
    cloned[WORKFLOW_BODY_GRAPH_CONFIG_KEY] = cloneDraftSchema(bodyGraph);
  }
  return cloned;
}

function getNodeBodyGraph(node: WorkflowNode): WorkflowSchema {
  const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
  return isWorkflowSchema(bodyGraph) ? cloneDraftSchema(bodyGraph) : createWorkflowBodyGraph(node.id);
}

function getSchemaAtPath(root: WorkflowSchema, path: string[]): WorkflowSchema {
  let current = root;

  for (const nodeId of path) {
    const node = current.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return root;
    }

    const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
    if (!isWorkflowSchema(bodyGraph)) {
      return root;
    }

    current = bodyGraph;
  }

  return current;
}

function updateSchemaAtPath(
  root: WorkflowSchema,
  path: string[],
  updater: (schema: WorkflowSchema) => WorkflowSchema
): WorkflowSchema {
  if (path.length === 0) {
    return updater(root);
  }

  const [nodeId, ...rest] = path;
  return {
    ...root,
    nodes: root.nodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }

      const nextBodyGraph = updateSchemaAtPath(getNodeBodyGraph(node), rest, updater);
      return {
        ...node,
        config: {
          ...node.config,
          [WORKFLOW_BODY_GRAPH_CONFIG_KEY]: nextBodyGraph
        }
      };
    })
  };
}

function getBodyPathLabels(root: WorkflowSchema, path: string[]): string[] {
  const labels: string[] = [];
  let current = root;

  for (const nodeId of path) {
    const node = current.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return labels;
    }

    labels.push(node.label || node.id);
    const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
    if (!isWorkflowSchema(bodyGraph)) {
      return labels;
    }

    current = bodyGraph;
  }

  return labels;
}

function simulateWorkflowTest(schema: WorkflowSchema, scope: WorkflowTestScope): WorkflowTestRun {
  const logs: WorkflowTestLogEntry[] = [];
  const targetSchemas =
    scope === "bodyGraph"
      ? collectBodyGraphs(schema)
      : [{ label: "Корневая схема", schema }];
  const runSchemas = targetSchemas.length > 0 ? targetSchemas : [{ label: "Корневая схема", schema }];

  runSchemas.forEach((item, schemaIndex) => {
    logs.push({
      id: `scope-${schemaIndex}`,
      event: "workflow.test.scope",
      message: `${item.label}: ${item.schema.nodes.length} узл.`
    });
    appendSchemaRunLogs(item.schema, logs, item.label);
  });

  logs.push({
    id: "workflow-test-completed",
    event: "workflow.test.completed",
    message: `Тестовый запуск завершён: ${logs.length} событий.`
  });

  return { logs, scope };
}

function appendSchemaRunLogs(
  schema: WorkflowSchema,
  logs: WorkflowTestLogEntry[],
  prefix: string
) {
  schema.nodes.forEach((node) => {
    logs.push({
      id: `${prefix}-${node.id}-completed`,
      event: "node.completed",
      message: `${prefix}: узел «${node.label}» (${workflowNodeTypeLabel(node.type)}) выполнен.`
    });

    const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
    if (isWorkflowSchema(bodyGraph)) {
      logs.push({
        id: `${prefix}-${node.id}-bodyGraph`,
        event: "bodyGraph.completed",
        message: `bodyGraph узла «${node.label}» выполнен: ${bodyGraph.nodes.length} узл.`
      });
      appendSchemaRunLogs(bodyGraph, logs, `${prefix} / ${node.label}`);
    }
  });
}

function collectBodyGraphs(schema: WorkflowSchema): Array<{ label: string; schema: WorkflowSchema }> {
  const bodyGraphs: Array<{ label: string; schema: WorkflowSchema }> = [];

  schema.nodes.forEach((node) => {
    const bodyGraph = node.config[WORKFLOW_BODY_GRAPH_CONFIG_KEY];
    if (!isWorkflowSchema(bodyGraph)) {
      return;
    }

    bodyGraphs.push({ label: `bodyGraph: ${node.label}`, schema: bodyGraph });
    bodyGraphs.push(...collectBodyGraphs(bodyGraph));
  });

  return bodyGraphs;
}

function workflowTestScopeLabel(scope: WorkflowTestScope): string {
  switch (scope) {
    case "schema":
      return "Схема";
    case "bodyGraph":
      return "bodyGraph";
  }
}

function nodePrimaryValue(node: WorkflowNode, key: string): string {
  const value = node.config[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeWorkflowImportPayload(
  value: unknown,
  workflow: Workflow,
  defaultVersion: WorkflowVersion
): ImportWorkflowRequest {
  if (isWorkflowSchemaExport(value)) {
    return { ...value, target: "draft" };
  }

  if (isWorkflowSchema(value)) {
    return {
      contract: "C5.WorkflowSchemaExport",
      exported_at: new Date().toISOString(),
      schema: value,
      target: "draft",
      version: "1.0.0",
      workflow: {
        id: workflow.id,
        name: workflow.name,
        version_id: defaultVersion.id,
        version_no: defaultVersion.version_no
      }
    };
  }

  throw new Error("Файл должен содержать экспорт Workflow JSON или объект schema.");
}

function isWorkflowSchemaExport(value: unknown): value is WorkflowSchemaExport {
  return (
    isRecord(value) &&
    value.contract === "C5.WorkflowSchemaExport" &&
    typeof value.version === "string" &&
    typeof value.exported_at === "string" &&
    isRecord(value.workflow) &&
    typeof value.workflow.id === "string" &&
    typeof value.workflow.name === "string" &&
    typeof value.workflow.version_id === "string" &&
    typeof value.workflow.version_no === "number" &&
    isWorkflowSchema(value.schema)
  );
}

/** Формирует экспортный конверт C5 для субсхемы (переиспользует загрузку в файл). */
function buildSubschemaExport(
  subschema: WorkflowSubschema,
  schema: WorkflowSchema
): WorkflowSchemaExport {
  return {
    contract: "C5.WorkflowSchemaExport",
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    workflow: {
      id: subschema.id,
      name: subschema.name,
      version_id: subschema.id,
      version_no: 1
    },
    schema: cloneDraftSchema(schema)
  };
}

function summarizeWorkflowSchemaDiff(current: WorkflowSchema, next: WorkflowSchema): string {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const addedNodes = next.nodes.filter((node) => !currentNodes.has(node.id)).length;
  const removedNodes = current.nodes.filter((node) => !nextNodes.has(node.id)).length;
  const changedNodes = next.nodes.filter((node) => {
    const previous = currentNodes.get(node.id);
    return previous ? JSON.stringify(previous) !== JSON.stringify(node) : false;
  }).length;
  const currentConnections = new Set(current.connections.map(connectionSignature));
  const nextConnections = new Set(next.connections.map(connectionSignature));
  const addedConnections = next.connections.filter(
    (connection) => !currentConnections.has(connectionSignature(connection))
  ).length;
  const removedConnections = current.connections.filter(
    (connection) => !nextConnections.has(connectionSignature(connection))
  ).length;

  const lines = [
    `Узлы: +${addedNodes}, -${removedNodes}, изменено ${changedNodes}.`,
    `Связи: +${addedConnections}, -${removedConnections}.`
  ];

  if (
    addedNodes === 0 &&
    removedNodes === 0 &&
    changedNodes === 0 &&
    addedConnections === 0 &&
    removedConnections === 0
  ) {
    lines.push("Отличий в узлах и связях не найдено.");
  }

  return lines.join("\n");
}

function connectionSignature(connection: WorkflowSchema["connections"][number]): string {
  return [
    connection.from,
    connection.fromPort,
    connection.to,
    connection.toPort,
    connection.label ?? ""
  ].join("::");
}

function downloadWorkflowExport(exported: WorkflowSchemaExport): void {
  const json = JSON.stringify(exported, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const anchor = document.createElement("a");
  const objectUrl =
    typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;

  anchor.href = objectUrl;
  anchor.download = `${sanitizeFileName(exported.workflow.name)}-v${exported.workflow.version_no}.workflow.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  if (objectUrl.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(objectUrl);
  }
}

function sanitizeFileName(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "workflow";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceWorkflow(workflows: Workflow[], next: Workflow) {
  return workflows.map((workflow) => (workflow.id === next.id ? next : workflow));
}

function getProblemMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
