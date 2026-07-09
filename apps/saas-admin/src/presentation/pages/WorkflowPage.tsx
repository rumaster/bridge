import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
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
  Save,
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
  WorkflowImportTarget,
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
import { Badge, Button, CheckboxInput, Panel, TextInput } from "../../shared/ui-kit";

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
  const [historyOpen, setHistoryOpen] = useState(false);

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

          <WorkflowTopbar
            historyOpen={historyOpen}
            onActivateVersion={(versionId) =>
              selectedWorkflow && void handleActivateVersion(selectedWorkflow, versionId)
            }
            onSelectWorkflow={setSelectedWorkflowId}
            onToggleEnabled={() =>
              selectedWorkflow && void handleToggleEnabled(selectedWorkflow)
            }
            onToggleHistory={() => setHistoryOpen((open) => !open)}
            pending={Boolean(selectedWorkflow) && pendingWorkflowId === selectedWorkflowId}
            selectedWorkflowId={selectedWorkflowId}
            versions={versions}
            workflow={selectedWorkflow}
            workflows={workflows}
          />

          <div className="workflow-body">
            {selectedWorkflow ? (
              detailLoading ? (
                <div className="route-loader">Загрузка версий и истории...</div>
              ) : versions.length > 0 ? (
                <WorkflowSchemaEditor
                  key={selectedWorkflow.id}
                  onVersionCreated={handleVersionCreated}
                  subschemas={subschemas}
                  versions={versions}
                  workflow={selectedWorkflow}
                />
              ) : null
            ) : null}

            {historyOpen && selectedWorkflow ? (
              <WorkflowInstancesPanel
                instances={instances}
                onClose={() => setHistoryOpen(false)}
                workflowId={selectedWorkflow.id}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface WorkflowTopbarProps {
  historyOpen: boolean;
  onActivateVersion: (versionId: string) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onToggleEnabled: () => void;
  onToggleHistory: () => void;
  pending: boolean;
  selectedWorkflowId: string | null;
  versions: WorkflowVersion[];
  workflow: Workflow | null;
  workflows: Workflow[];
}

/**
 * Верхняя панель редактора Workflow (ТЗ §13, макет fbp_engine): выбор схемы через
 * выпадающий список, статус, включение/отключение, активная версия по умолчанию и
 * переключатель истории исполнения. Освобождает пространство под холст редактора.
 */
function WorkflowTopbar({
  historyOpen,
  onActivateVersion,
  onSelectWorkflow,
  onToggleEnabled,
  onToggleHistory,
  pending,
  selectedWorkflowId,
  versions,
  workflow,
  workflows
}: WorkflowTopbarProps) {
  const versionSelectId = "workflow-active-version";
  return (
    <div className="workflow-topbar">
      <label className="workflow-select workflow-topbar-scheme">
        <span>Схема Workflow</span>
        <select
          aria-label="Схема Workflow"
          disabled={workflows.length === 0}
          onChange={(event) => onSelectWorkflow(event.currentTarget.value)}
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

      {workflow ? (
        <>
          <div className="workflow-topbar-meta">
            <h2>{workflow.name}</h2>
            <div className="workflow-topbar-tags">
              <Badge tone={workflowStatusTone(workflow.status)}>
                {workflowStatusLabel(workflow.status)}
              </Badge>
              <Badge tone={workflow.enabled ? "success" : "neutral"}>
                {workflow.enabled ? "Включен" : "Отключен"}
              </Badge>
            </div>
          </div>

          <div className="workflow-topbar-actions">
            <Button
              disabled={pending}
              onClick={onToggleEnabled}
              type="button"
              variant="secondary"
            >
              <Power aria-hidden="true" size={16} />
              {workflow.enabled ? "Отключить" : "Включить"}
            </Button>

            <label className="workflow-select workflow-topbar-version">
              <span>Активная версия по умолчанию</span>
              <select
                disabled={pending || versions.length === 0}
                id={versionSelectId}
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

            <Button
              aria-pressed={historyOpen}
              onClick={onToggleHistory}
              type="button"
              variant={historyOpen ? "primary" : "secondary"}
            >
              <History aria-hidden="true" size={16} />
              История исполнения
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface WorkflowSchemaEditorProps {
  onVersionCreated: (version: WorkflowVersion, activated: boolean) => void;
  subschemas: WorkflowSubschema[];
  versions: WorkflowVersion[];
  workflow: Workflow;
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

function WorkflowSchemaEditor({
  onVersionCreated,
  subschemas,
  versions,
  workflow
}: WorkflowSchemaEditorProps) {
  const api = useSaasAdminApi();
  const defaultVersion = useMemo(
    () => versions.find((version) => version.id === workflow.default_version_id) ?? versions[0],
    [versions, workflow.default_version_id]
  );
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
  const [activateOnSave, setActivateOnSave] = useState(false);
  const [importTarget, setImportTarget] = useState<WorkflowImportTarget>("draft");
  const [hasDraft, setHasDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [testScope, setTestScope] = useState<WorkflowTestScope>("schema");
  const [testRun, setTestRun] = useState<WorkflowTestRun | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorAlert, setEditorAlert] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

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
    hasDraft,
    schema: rootDraftSchema,
    valid: validation.valid,
    workflowId: workflow.id
  });

  useEffect(() => {
    latestDraftRef.current = {
      draftSaved,
      hasDraft,
      schema: rootDraftSchema,
      valid: validation.valid,
      workflowId: workflow.id
    };
  }, [draftSaved, hasDraft, rootDraftSchema, validation.valid, workflow.id]);

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
      if (latest.workflowId === workflow.id && latest.hasDraft && !latest.draftSaved && latest.valid) {
        void api.workflows.saveDraft(workflow.id, { schema: latest.schema });
      }
    };
  }, [api, workflow.id]);

  async function loadVersionSchema(versionId: string) {
    const base = versions.find((version) => version.id === versionId);
    if (!base) {
      return;
    }
    if (hasDraft && !draftSaved) {
      const saved = await persistDraft("Текущий черновик сохранён перед переключением версии.");
      if (!saved) {
        return;
      }
    }
    setBaseVersionId(versionId);
    setRootDraftSchema(cloneDraftSchema(base.schema));
    setBodyPath([]);
    setSelectedNodeId(base.schema.nodes[0]?.id ?? null);
    setConnectionFrom("");
    setConnectionTo("");
    setHasDraft(false);
    setDraftSaved(false);
    setDraftUpdatedAt(null);
    setTestRun(null);
    setEditorAlert(null);
    setEditorNotice(null);
  }

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

  async function handleSaveDraft() {
    await persistDraft();
  }

  async function handleSave(activate = activateOnSave, notice?: string) {
    if (!validation.valid) {
      setEditorAlert("Исправьте ошибки схемы перед сохранением.");
      return;
    }

    setSaving(true);
    setEditorAlert(null);

    try {
      const version = await api.workflows.createVersion(workflow.id, {
        schema: rootDraftSchema,
        activate
      });
      if (hasDraft) {
        await api.workflows.resetDraft(workflow.id);
      }
      onVersionCreated(version, activate);
      setBaseVersionId(version.id);
      setRootDraftSchema(cloneDraftSchema(version.schema));
      setBodyPath([]);
      setSelectedNodeId(version.schema.nodes[0]?.id ?? null);
      setHasDraft(false);
      setDraftSaved(false);
      setDraftUpdatedAt(null);
      setActivateOnSave(false);
      setEditorNotice(notice ?? null);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось сохранить новую версию."));
    } finally {
      setSaving(false);
    }
  }

  async function handlePublishDraft() {
    if (!validation.valid) {
      setEditorAlert("Исправьте ошибки схемы перед публикацией черновика.");
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
      setActivateOnSave(false);
      setTestRun(null);
      setEditorNotice("Черновик опубликован как активная версия.");
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось опубликовать черновик."));
    } finally {
      setSaving(false);
    }
  }

  async function handleResetDraft() {
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
      setEditorNotice(`Черновик сброшен к активной версии v${base.version_no}.`);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось сбросить черновик."));
    } finally {
      setSaving(false);
    }
  }

  async function handleExportWorkflow() {
    setSaving(true);
    setEditorAlert(null);
    setEditorNotice(null);

    try {
      const exported = await api.workflows.exportWorkflow(workflow.id);
      downloadWorkflowExport(exported);
      setEditorNotice(`Экспортирована активная версия v${exported.workflow.version_no}.`);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось экспортировать Workflow JSON."));
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
      const targetLabel = workflowImportTargetLabel(importTarget);
      const confirmed = window.confirm(
        `Импортировать JSON Workflow как ${targetLabel}?\n${diffSummary}`,
      );
      if (!confirmed) {
        return;
      }

      const imported = await api.workflows.importWorkflow(workflow.id, {
        ...payload,
        activate: importTarget === "version" ? activateOnSave : undefined,
        target: importTarget
      });

      const importedSchema =
        imported.target === "version" ? imported.version?.schema : imported.draft?.schema;
      if (!importedSchema) {
        throw new Error("Workflow import did not return a schema.");
      }
      if (imported.target === "version" && imported.version) {
        onVersionCreated(imported.version, Boolean(activateOnSave));
        if (hasDraft) {
          await api.workflows.resetDraft(workflow.id);
        }
      }

      setRootDraftSchema(cloneDraftSchema(importedSchema));
      setBaseVersionId(
        imported.target === "version" && imported.version ? imported.version.id : defaultVersion.id
      );
      setBodyPath([]);
      setSelectedNodeId(importedSchema.nodes[0]?.id ?? null);
      setConnectionFrom("");
      setConnectionTo("");
      setHasDraft(imported.target === "draft");
      setDraftSaved(imported.target === "draft");
      setDraftUpdatedAt(imported.target === "draft" ? imported.draft?.draft_updated_at ?? null : null);
      setTestRun(null);
      setEditorNotice(
        imported.target === "version"
          ? `JSON импортирован как новая версия v${imported.version?.version_no}.`
          : "JSON импортирован и сохранён как черновик.",
      );
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось импортировать Workflow JSON."));
    } finally {
      setSaving(false);
    }
  }

  async function handleRunTest() {
    if (hasDraft && !draftSaved) {
      const saved = await persistDraft("Черновик автосохранён перед тестовым запуском.");
      if (!saved) {
        return;
      }
    }
    setTestRun(simulateWorkflowTest(rootDraftSchema, testScope));
    setEditorAlert(null);
    setEditorNotice("Тестовый запуск завершён.");
  }

  return (
    <section aria-label="Редактор схемы Workflow" className="workflow-editor">
      <div className="workflow-editor-toolbar">
        <div className="workflow-breadcrumb" aria-label="Текущий граф">
          <Boxes aria-hidden="true" size={16} />
          <span>{["Корневая схема", ...bodyPathLabels].join(" / ")}</span>
          <Badge tone={hasDraft ? "warning" : "success"}>
            {hasDraft ? (draftSaved ? "Черновик сохранён" : "Есть черновик") : "Опубликовано"}
          </Badge>
          {draftUpdatedAt ? <span className="muted">сохранён {draftUpdatedAt}</span> : null}
          {bodyPath.length > 0 ? (
            <Button onClick={handleExitBodyGraph} type="button" variant="secondary">
              <ArrowLeft aria-hidden="true" size={16} />
              Вернуться к родительской схеме
            </Button>
          ) : null}
        </div>

        <div className="workflow-editor-actions">
          <label className="workflow-select workflow-editor-base">
            <span>Редактируемая версия</span>
            <select
              id={`workflow-base-version-${workflow.id}`}
              onChange={(event) => void loadVersionSchema(event.currentTarget.value)}
              value={baseVersionId}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version_no}
                  {version.id === workflow.default_version_id ? " · активная" : ""}
                </option>
              ))}
            </select>
          </label>

          <CheckboxInput
            checked={activateOnSave}
            id={`workflow-activate-${workflow.id}`}
            label="Активировать сразу"
            onChange={(event) => setActivateOnSave(event.currentTarget.checked)}
          />
          <Button
            disabled={saving || draftLoading || !validation.valid}
            onClick={() => void handleSave()}
            type="button"
          >
            <Save aria-hidden="true" size={16} />
            Сохранить как новую версию
          </Button>
          <Button
            disabled={saving || draftLoading || !validation.valid}
            onClick={() => void handleSaveDraft()}
            type="button"
            variant="secondary"
          >
            <Save aria-hidden="true" size={16} />
            Сохранить черновик
          </Button>
          <Button
            disabled={saving || draftLoading || !validation.valid || !hasDraft}
            onClick={() => void handlePublishDraft()}
            type="button"
          >
            <UploadCloud aria-hidden="true" size={16} />
            Опубликовать черновик
          </Button>
          <Button
            disabled={saving || draftLoading || !hasDraft}
            onClick={() => void handleResetDraft()}
            type="button"
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" size={16} />
            Сбросить черновик
          </Button>
          <Button
            disabled={saving || draftLoading}
            onClick={() => void handleExportWorkflow()}
            type="button"
            variant="secondary"
          >
            <Download aria-hidden="true" size={16} />
            Экспорт JSON
          </Button>
          <label className="workflow-select workflow-import-target">
            <span>Цель импорта</span>
            <select
              disabled={saving || draftLoading}
              onChange={(event) =>
                setImportTarget(event.currentTarget.value as WorkflowImportTarget)
              }
              value={importTarget}
            >
              <option value="draft">Черновик</option>
              <option value="version">Новая версия</option>
            </select>
          </label>
          <Button
            disabled={saving || draftLoading}
            onClick={handleImportClick}
            type="button"
            variant="secondary"
          >
            <FileUp aria-hidden="true" size={16} />
            Импорт JSON
          </Button>
          <input
            accept="application/json,.json"
            aria-label="Файл импорта Workflow JSON"
            onChange={(event) => void handleImportFile(event)}
            ref={importInputRef}
            style={{ display: "none" }}
            type="file"
          />
          <label className="workflow-select workflow-test-scope">
            <span>Область теста</span>
            <select
              onChange={(event) => setTestScope(event.currentTarget.value as WorkflowTestScope)}
              value={testScope}
            >
              <option value="schema">Схема</option>
              <option value="bodyGraph">Текущая bodyGraph</option>
            </select>
          </label>
          <Button
            disabled={!validation.valid}
            onClick={() => void handleRunTest()}
            type="button"
            variant="secondary"
          >
            <FlaskConical aria-hidden="true" size={16} />
            Тестовый запуск
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
            <h3>Информация о схеме</h3>
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

        <WorkflowCanvas
          connections={draftSchema.connections}
          key={bodyPath.join("/") || baseVersionId}
          nodes={draftSchema.nodes}
          onDropNode={handleAddNode}
          onMoveNode={handleMoveNode}
          onSelectNode={setSelectedNodeId}
          selectedNodeId={selectedNodeId}
        />

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
          ) : null}
        </div>
      </div>
    </section>
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
  onClose: () => void;
  workflowId: string;
}

function WorkflowInstancesPanel({ instances, onClose, workflowId }: WorkflowInstancesPanelProps) {
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
    <Panel aria-label="История исполнения Workflow" as="section" className="workflow-instances">
      <div className="panel-heading-row">
        <div className="channel-title">
          <History aria-hidden="true" size={20} />
          <div>
            <h2>История исполнения</h2>
            <p>Просмотр запусков и диагностики (без влияния на активные инстансы).</p>
          </div>
        </div>
        <Button
          aria-label="Закрыть историю исполнения"
          onClick={onClose}
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={16} />
          Закрыть
        </Button>
      </div>

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
    </Panel>
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

function workflowImportTargetLabel(target: WorkflowImportTarget): string {
  switch (target) {
    case "draft":
      return "черновик";
    case "version":
      return "новую версию";
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
