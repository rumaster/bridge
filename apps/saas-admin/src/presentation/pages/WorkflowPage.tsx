import { useEffect, useMemo, useState } from "react";
import {
  Database,
  History,
  Link2,
  Play,
  Plus,
  Power,
  Save,
  ShieldCheck,
  Trash2,
  Workflow as WorkflowIcon
} from "lucide-react";

import type {
  Workflow,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowSchema,
  WorkflowVersion
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import {
  SAFE_WORKFLOW_NODE_TYPES,
  createWorkflowConnection,
  createWorkflowNode,
  validateWorkflowSchema,
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
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
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
      setInstances([]);
      return () => {
        active = false;
      };
    }

    setDetailLoading(true);
    Promise.all([
      api.workflows.listVersions(selectedWorkflowId),
      api.workflows.listInstances(selectedWorkflowId)
    ])
      .then(([nextVersions, nextInstances]) => {
        if (!active) {
          return;
        }
        setVersions(nextVersions);
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
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Автоматизация</Badge>
        <h1>Workflow</h1>
        <p>
          Список Workflow (C5), безопасный редактор схемы (ТЗ §13.13) и сохранение изменений новой
          версией (ТЗ §13.10) — выполняющиеся инстансы не затрагиваются.
        </p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел скрыт для текущей роли</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canEdit ? (
        <>
          {loading ? <div className="route-loader">Загрузка Workflow...</div> : null}

          <div className="workflow-layout">
            <WorkflowListPanel
              onSelect={setSelectedWorkflowId}
              onToggleEnabled={(workflow) => void handleToggleEnabled(workflow)}
              pendingWorkflowId={pendingWorkflowId}
              selectedWorkflowId={selectedWorkflowId}
              workflows={workflows}
            />

            {selectedWorkflow ? (
              <div className="workflow-detail">
                <WorkflowVersionBar
                  disabled={pendingWorkflowId === selectedWorkflow.id}
                  onActivateVersion={(versionId) =>
                    void handleActivateVersion(selectedWorkflow, versionId)
                  }
                  versions={versions}
                  workflow={selectedWorkflow}
                />

                {detailLoading ? (
                  <div className="route-loader">Загрузка версий и истории...</div>
                ) : versions.length > 0 ? (
                  <WorkflowSchemaEditor
                    key={selectedWorkflow.id}
                    onVersionCreated={handleVersionCreated}
                    versions={versions}
                    workflow={selectedWorkflow}
                  />
                ) : null}

                <WorkflowInstancesPanel instances={instances} workflowId={selectedWorkflow.id} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface WorkflowListPanelProps {
  onSelect: (workflowId: string) => void;
  onToggleEnabled: (workflow: Workflow) => void;
  pendingWorkflowId: string | null;
  selectedWorkflowId: string | null;
  workflows: Workflow[];
}

function WorkflowListPanel({
  onSelect,
  onToggleEnabled,
  pendingWorkflowId,
  selectedWorkflowId,
  workflows
}: WorkflowListPanelProps) {
  return (
    <Panel aria-label="Список Workflow" as="section" className="workflow-list">
      <div className="panel-heading-row">
        <div>
          <h2>Список Workflow</h2>
          <p>Включение/отключение и выбор активной версии (ТЗ §16.7).</p>
        </div>
      </div>

      <ul className="workflow-list-items">
        {workflows.map((workflow) => {
          const selected = workflow.id === selectedWorkflowId;
          return (
            <li className={`workflow-list-item ${selected ? "selected" : ""}`} key={workflow.id}>
              <button
                aria-current={selected}
                aria-label={`Открыть Workflow ${workflow.name}`}
                className="workflow-list-select"
                onClick={() => onSelect(workflow.id)}
                type="button"
              >
                <span className="workflow-list-title">
                  <WorkflowIcon aria-hidden="true" size={18} />
                  {workflow.name}
                </span>
                <span className="muted">{workflow.description}</span>
                <span className="workflow-list-tags">
                  <Badge tone={workflowStatusTone(workflow.status)}>
                    {workflowStatusLabel(workflow.status)}
                  </Badge>
                  <Badge tone={workflow.enabled ? "success" : "neutral"}>
                    {workflow.enabled ? "Включен" : "Отключен"}
                  </Badge>
                </span>
              </button>
              <Button
                className="workflow-toggle"
                disabled={pendingWorkflowId === workflow.id}
                onClick={() => onToggleEnabled(workflow)}
                type="button"
                variant="secondary"
              >
                <Power aria-hidden="true" size={16} />
                {workflow.enabled ? "Отключить" : "Включить"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

interface WorkflowVersionBarProps {
  disabled: boolean;
  onActivateVersion: (versionId: string) => void;
  versions: WorkflowVersion[];
  workflow: Workflow;
}

function WorkflowVersionBar({
  disabled,
  onActivateVersion,
  versions,
  workflow
}: WorkflowVersionBarProps) {
  const selectId = `workflow-active-version-${workflow.id}`;
  return (
    <Panel className="workflow-version-bar">
      <div className="workflow-version-heading">
        <h2>{workflow.name}</h2>
        <span className="muted">{workflow.description}</span>
      </div>
      <div className="workflow-version-control">
        <label htmlFor={selectId}>Активная версия по умолчанию</label>
        <select
          disabled={disabled || versions.length === 0}
          id={selectId}
          onChange={(event) => onActivateVersion(event.currentTarget.value)}
          value={workflow.default_version_id}
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              v{version.version_no} · {version.created_at}
            </option>
          ))}
        </select>
        <span className="muted">
          Переключение версии не влияет на уже выполняющиеся инстансы (ТЗ §13.10).
        </span>
      </div>
    </Panel>
  );
}

interface WorkflowSchemaEditorProps {
  onVersionCreated: (version: WorkflowVersion, activated: boolean) => void;
  versions: WorkflowVersion[];
  workflow: Workflow;
}

function WorkflowSchemaEditor({ onVersionCreated, versions, workflow }: WorkflowSchemaEditorProps) {
  const api = useSaasAdminApi();
  const defaultVersion = useMemo(
    () => versions.find((version) => version.id === workflow.default_version_id) ?? versions[0],
    [versions, workflow.default_version_id]
  );
  const [baseVersionId, setBaseVersionId] = useState(defaultVersion.id);
  const [draftSchema, setDraftSchema] = useState<WorkflowSchema>(() =>
    cloneDraftSchema(defaultVersion.schema)
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => defaultVersion.schema.nodes[0]?.id ?? null
  );
  const [connectionFrom, setConnectionFrom] = useState("");
  const [connectionTo, setConnectionTo] = useState("");
  const [activateOnSave, setActivateOnSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorAlert, setEditorAlert] = useState<string | null>(null);

  const validation = useMemo(() => validateWorkflowSchema(draftSchema), [draftSchema]);
  const selectedNode = useMemo(
    () => draftSchema.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [draftSchema.nodes, selectedNodeId]
  );

  function loadVersionSchema(versionId: string) {
    const base = versions.find((version) => version.id === versionId);
    if (!base) {
      return;
    }
    setBaseVersionId(versionId);
    setDraftSchema(cloneDraftSchema(base.schema));
    setSelectedNodeId(base.schema.nodes[0]?.id ?? null);
    setConnectionFrom("");
    setConnectionTo("");
    setEditorAlert(null);
  }

  function handleAddNode(type: WorkflowNodeType) {
    setDraftSchema((current) => {
      const node = createWorkflowNode(type, current.nodes);
      setSelectedNodeId(node.id);
      return { ...current, nodes: [...current.nodes, node] };
    });
    setEditorAlert(null);
  }

  function handleUpdateNodeLabel(nodeId: string, label: string) {
    setDraftSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, label } : node))
    }));
  }

  function handleUpdateNodeConfig(nodeId: string, key: string, value: string) {
    setDraftSchema((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, config: { ...node.config, [key]: value } } : node
      )
    }));
  }

  function handleDeleteNode(nodeId: string) {
    setDraftSchema((current) => ({
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
    setDraftSchema((current) => ({
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
    setDraftSchema((current) => ({
      ...current,
      connections: current.connections.filter((connection) => connection.id !== connectionId)
    }));
  }

  async function handleSave() {
    if (!validation.valid) {
      setEditorAlert("Исправьте ошибки схемы перед сохранением.");
      return;
    }

    setSaving(true);
    setEditorAlert(null);

    try {
      const version = await api.workflows.createVersion(workflow.id, {
        schema: draftSchema,
        activate: activateOnSave
      });
      onVersionCreated(version, activateOnSave);
      setBaseVersionId(version.id);
      setDraftSchema(cloneDraftSchema(version.schema));
      setActivateOnSave(false);
    } catch (error) {
      setEditorAlert(getProblemMessage(error, "Не удалось сохранить новую версию."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel aria-label="Редактор схемы Workflow" as="section" className="workflow-editor">
      <div className="panel-heading-row">
        <div>
          <h2>Редактор схемы</h2>
          <p>
            Палитра ограничена безопасным набором узлов (ТЗ §13.13). Данные изменяет только узел
            вызова Backend API (ТЗ §13.5).
          </p>
        </div>
        <div className="workflow-editor-base">
          <label htmlFor={`workflow-base-version-${workflow.id}`}>Редактируемая версия</label>
          <select
            id={`workflow-base-version-${workflow.id}`}
            onChange={(event) => loadVersionSchema(event.currentTarget.value)}
            value={baseVersionId}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version_no}
                {version.id === workflow.default_version_id ? " · активная" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {editorAlert ? (
        <div className="form-alert" role="alert">
          {editorAlert}
        </div>
      ) : null}

      <div className="workflow-editor-grid">
        <div className="workflow-palette" aria-label="Палитра узлов">
          <h3>Палитра узлов</h3>
          {SAFE_WORKFLOW_NODE_TYPES.map((type) => (
            <button
              aria-label={`Добавить узел: ${workflowNodeTypeLabel(type)}`}
              className={`workflow-palette-item ${workflowNodeMutatesData(type) ? "mutating" : ""}`}
              key={type}
              onClick={() => handleAddNode(type)}
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
          nodes={draftSchema.nodes}
          onSelectNode={setSelectedNodeId}
          selectedNodeId={selectedNodeId}
        />

        <WorkflowNodeProperties
          node={selectedNode}
          onDeleteNode={handleDeleteNode}
          onUpdateConfig={handleUpdateNodeConfig}
          onUpdateLabel={handleUpdateNodeLabel}
        />
      </div>

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

      <div className="workflow-save-row">
        <CheckboxInput
          checked={activateOnSave}
          id={`workflow-activate-${workflow.id}`}
          label="Сделать новую версию активной сразу"
          onChange={(event) => setActivateOnSave(event.currentTarget.checked)}
        />
        <Button
          disabled={saving || !validation.valid}
          onClick={() => void handleSave()}
          type="button"
        >
          <Save aria-hidden="true" size={16} />
          Сохранить как новую версию
        </Button>
      </div>
      <p className="muted workflow-save-hint">
        Сохранение создаёт неизменяемую версию и не влияет на выполняющиеся инстансы (ТЗ §13.10).
      </p>
    </Panel>
  );
}

interface WorkflowCanvasProps {
  connections: WorkflowSchema["connections"];
  nodes: WorkflowNode[];
  onSelectNode: (nodeId: string) => void;
  selectedNodeId: string | null;
}

const NODE_WIDTH = 176;
const NODE_HEIGHT = 68;

function WorkflowCanvas({ connections, nodes, onSelectNode, selectedNodeId }: WorkflowCanvasProps) {
  const width = Math.max(480, ...nodes.map((node) => node.position.x + NODE_WIDTH + 40));
  const height = Math.max(280, ...nodes.map((node) => node.position.y + NODE_HEIGHT + 40));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

  return (
    <div className="workflow-canvas" aria-label="Схема узлов и связей" role="group">
      <div className="workflow-canvas-surface" style={{ width, height }}>
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
            key={node.id}
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

interface WorkflowNodePropertiesProps {
  node: WorkflowNode | null;
  onDeleteNode: (nodeId: string) => void;
  onUpdateConfig: (nodeId: string, key: string, value: string) => void;
  onUpdateLabel: (nodeId: string, label: string) => void;
}

function WorkflowNodeProperties({
  node,
  onDeleteNode,
  onUpdateConfig,
  onUpdateLabel
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
      <TextInput
        id={`workflow-node-${primary.key}-${node.id}`}
        label={primary.label}
        onChange={(event) => onUpdateConfig(node.id, primary.key, event.currentTarget.value)}
        placeholder={primary.placeholder}
        value={nodePrimaryValue(node, primary.key)}
      />
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
    <Panel aria-label="История исполнения Workflow" as="section" className="workflow-instances">
      <div className="panel-heading-row">
        <div className="channel-title">
          <History aria-hidden="true" size={20} />
          <div>
            <h2>История исполнения</h2>
            <p>Просмотр запусков и диагностики (без влияния на активные инстансы).</p>
          </div>
        </div>
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
    nodes: schema.nodes.map((node) => ({
      ...node,
      config: { ...node.config },
      position: { ...node.position }
    })),
    connections: schema.connections.map((connection) => ({ ...connection }))
  };
}

function nodePrimaryValue(node: WorkflowNode, key: string): string {
  const value = node.config[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
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
