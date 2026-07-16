import type { FbpGraphKind, WorkflowSchema } from "@bridge/contracts/c5-workflow";
import { Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BackendApiAllowlistEntry,
  Workflow,
  WorkflowDraftTestResult,
  WorkflowSubschema,
} from "../../api/client/types";
import { Badge, Button, Panel, SelectInput } from "../../shared/ui-kit";
import {
  createWorkflowNode,
  createWorkflowSchema,
  validateWorkflowSchema,
  workflowNodePalette,
  workflowNodeTypeDescription,
} from "../../shared/workflow";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import { NodePropertiesPanel } from "../workflow/NodePropertiesPanel";
import { TestRunPanel } from "../workflow/TestRunPanel";
import { WorkflowCanvas } from "../workflow/WorkflowCanvas";
import { addGraphNode, findGraphNode, patchGraphNode, waitEventNodes } from "../workflow/graph-ops";

/**
 * Редактор схем Workflow 2.0 (этап 7 переработки).
 *
 * Заменил монолит на 2158 строк: самописный холст с ручным drag&drop, связи
 * списком вместо рёбер и «тестовый прогон», который ничего не исполнял, а печатал
 * `completed` для каждого узла в порядке массива (дефект D5).
 *
 * Модель работы: редактор ВСЕГДА открывает драфт; драфт автосохраняется при уходе
 * со схемы и при размонтировании; кнопка «Сохранить» — это promote, то есть
 * копирование драфта в неизменяемую рабочую версию (§13.10).
 */
export default function WorkflowPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["platform_operator"]);

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string>("");
  const [graph, setGraph] = useState<WorkflowSchema | null>(null);
  const [subschemas, setSubschemas] = useState<WorkflowSubschema[]>([]);
  const [allowlist, setAllowlist] = useState<BackendApiAllowlistEntry[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [alert, setAlert] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<WorkflowDraftTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testRunning, setTestRunning] = useState(false);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;

    void (async () => {
      const loadedWorkflows = await api.workflows.listWorkflows();
      // Субсхемы и витрина — вспомогательные: без них редактор всё равно должен
      // открыться (просто селектбоксы sub_schema/backend-api покажут «пусто»).
      // Ронять из-за них весь экран нельзя — тем более что витрина появилась
      // позже и на бэкенде без неё ответит 404.
      const loadedSubschemas = await api.workflows.listSubschemas().catch(() => []);
      const loadedAllowlist = await api.workflows.listBackendApiAllowlist().catch(() => []);
      if (cancelled) return;
      setWorkflows(loadedWorkflows);
      setSubschemas(loadedSubschemas);
      setAllowlist(loadedAllowlist);
      if (loadedWorkflows.length > 0) setWorkflowId((current) => current || loadedWorkflows[0].id);
    })();

    return () => {
      cancelled = true;
    };
  }, [api, canEdit]);

  /**
   * Автосохранение драфта. Держится в ref, потому что его зовёт cleanup эффекта:
   * замыкание, снятое на монтировании, увидело бы пустой граф и затёрло бы им
   * работу оператора.
   */
  const autoSaveRef = useRef<() => Promise<void>>(async () => {});
  autoSaveRef.current = async () => {
    if (!dirty || !graph || workflowId === "" || !canEdit) return;
    try {
      await api.workflows.saveDraft(workflowId, { schema: graph });
      setDirty(false);
    } catch {
      // Автосохранение молчит: оно фоновое и не должно перебивать то, что оператор
      // делает сейчас. Об ошибке скажет явное сохранение.
    }
  };

  // Загрузка драфта при выборе схемы; уход со схемы автосохраняет предыдущую.
  useEffect(() => {
    if (workflowId === "" || !canEdit) return;
    let cancelled = false;

    void (async () => {
      const draft = await api.workflows.getDraft(workflowId);
      if (cancelled) return;
      // Драфта может не быть вовсе: у схемы, которую ещё не открывали, его нет.
      setGraph(draft.schema ?? createWorkflowSchema("workflow"));
      setSelectedNodeId(null);
      setTestResult(null);
      setTestError("");
      setDirty(false);
    })();

    // Cleanup срабатывает и при смене схемы, и при размонтировании страницы —
    // оба случая суть уход из редактора, и оба должны автосохранить. Отдельного
    // unmount-эффекта нет намеренно: он дал бы второй вызов автосейва на
    // размонтировании (cleanup этого эффекта + свой), то есть двойное сохранение.
    return () => {
      cancelled = true;
      void autoSaveRef.current();
    };
  }, [api, canEdit, workflowId]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === workflowId) ?? null,
    [workflowId, workflows],
  );
  const kind: FbpGraphKind = graph?.kind ?? "workflow";
  const palette = useMemo(() => workflowNodePalette(kind), [kind]);
  const selectedNode = useMemo(() => findGraphNode(graph, selectedNodeId), [graph, selectedNodeId]);
  const entryNodes = useMemo(() => (graph ? waitEventNodes(graph) : []), [graph]);
  const validation = useMemo(() => (graph ? validateWorkflowSchema(graph) : null), [graph]);

  const visitedNodeIds = useMemo(
    () => (testResult?.trace ?? []).map((entry) => entry.nodeId),
    [testResult],
  );
  const failedNodeId = useMemo(
    () => testResult?.trace.find((entry) => entry.failed)?.nodeId ?? null,
    [testResult],
  );

  const updateGraph = useCallback((next: WorkflowSchema) => {
    setGraph(next);
    setDirty(true);
    setNotice("");
  }, []);

  const addNode = (type: string): void => {
    if (!graph) return;
    const node = createWorkflowNode(type as never, graph.nodes);
    updateGraph(addGraphNode(graph, node));
    setSelectedNodeId(node.id);
  };

  /** «Сохранить» — это promote: драфт копируется в неизменяемую рабочую версию. */
  const save = async (): Promise<void> => {
    if (!graph || workflowId === "") return;
    setAlert("");
    setNotice("");
    try {
      await api.workflows.saveDraft(workflowId, { schema: graph });
      setDirty(false);
      const version = await api.workflows.promoteDraft(workflowId);
      setNotice(`Схема сохранена как версия ${version.version_no}.`);
    } catch (error) {
      setAlert(error instanceof Error ? error.message : "Не удалось сохранить схему.");
    }
  };

  const runTest = async (nodeId: string, payload: Record<string, unknown>): Promise<void> => {
    if (workflowId === "" || !graph) return;
    setTestRunning(true);
    setTestError("");
    setTestResult(null);
    try {
      // Прогон гоняет СОХРАНЁННЫЙ драфт, поэтому сначала сохраняем: иначе оператор
      // тестировал бы одно, а видел результат другого.
      await api.workflows.saveDraft(workflowId, { schema: graph });
      setDirty(false);
      setTestResult(
        await api.workflows.testDraft(workflowId, { node_id: nodeId, event_payload: payload }),
      );
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Прогон не выполнен.");
    } finally {
      setTestRunning(false);
    }
  };

  if (!canEdit) {
    // Заголовок «Workflow» на экране в любом случае: это маркер раздела для
    // навигации и скринридера. Редактор под ним скрыт — правка схем доступна
    // только оператору платформы.
    return (
      <div className="wf-page">
        <h1>Workflow</h1>
        <p>Раздел Workflow доступен только оператору платформы.</p>
      </div>
    );
  }

  return (
    <div className="wf-page">
      {/* Единственный H1 экрана: приёмка §21 требует его для скринридера. */}
      <h1>Workflow</h1>
      {/* div, а не header: header верхнего уровня — это лендмарк banner, а он у
          приложения уже есть. Второй ломает навигацию скринридера. */}
      <div className="wf-topbar">
        <SelectInput
          id="wf-schema-select"
          label="Схема Workflow"
          onChange={(event) => setWorkflowId(event.currentTarget.value)}
          options={workflows.map((workflow) => ({ label: workflow.name, value: workflow.id }))}
          value={workflowId}
        />
        <div className="wf-topbar-status">
          {/* Имя выбранной схемы заголовком, а не только в селекте: по нему видно,
              что именно правится, и на него опирается информационная архитектура. */}
          {selectedWorkflow ? <h2 className="wf-schema-name">{selectedWorkflow.name}</h2> : null}
          {dirty ? <Badge tone="warning">Есть незафиксированный черновик</Badge> : null}
          {validation && !validation.valid ? (
            <Badge tone="warning">Схема не готова к сохранению</Badge>
          ) : null}
        </div>
        <Button asLink to="/workflows/backend-api" variant="secondary">
          <ShieldCheck aria-hidden="true" size={16} />
          Витрина вызовов
        </Button>
        <Button disabled={!graph} onClick={save} type="button">
          <Save aria-hidden="true" size={16} />
          Сохранить
        </Button>
      </div>

      {alert ? <p className="wf-error">{alert}</p> : null}
      {notice ? <p className="wf-notice">{notice}</p> : null}
      {validation && !validation.valid ? (
        <ul className="wf-validation" data-testid="workflow-validation">
          {validation.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="wf-layout">
        <Panel>
          <h2>Палитра</h2>
          {/* Палитра зависит от вида графа: start/end допустимы только в субсхеме. */}
          <div className="wf-palette">
            {palette.map((definition) => (
              <button
                className="wf-palette-item"
                key={definition.type}
                onClick={() => addNode(definition.type)}
                title={workflowNodeTypeDescription(definition.type as never)}
                type="button"
              >
                <span className="wf-palette-label">{definition.label}</span>
                {definition.mutatesData ? (
                  <span className="wf-palette-mutates">Изменяет данные</span>
                ) : null}
              </button>
            ))}
          </div>
        </Panel>

        {graph ? (
          <WorkflowCanvas
            failedNodeId={failedNodeId}
            graph={graph}
            onChange={updateGraph}
            onError={setAlert}
            onSelectNode={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
            visitedNodeIds={visitedNodeIds}
          />
        ) : (
          <div className="wf-canvas" />
        )}

        <aside className="wf-side">
          {selectedNode && graph ? (
            <NodePropertiesPanel
              allowlist={allowlist}
              graph={graph}
              node={selectedNode}
              onPatch={(patch) => updateGraph(patchGraphNode(graph, selectedNode.id, patch))}
              subschemas={subschemas}
            />
          ) : (
            <p className="wf-hint">Выберите узел, чтобы увидеть его свойства.</p>
          )}

          <Panel>
            <h2>Тестовый прогон</h2>
            <TestRunPanel
              error={testError}
              onRun={runTest}
              onSelectNode={setSelectedNodeId}
              result={testResult}
              running={testRunning}
              waitEventNodes={entryNodes}
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
