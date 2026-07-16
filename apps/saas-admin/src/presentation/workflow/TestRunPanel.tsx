import { getWorkflowEventDefinition, WORKFLOW_EVENT_DEFINITIONS } from "@bridge/contracts/workflow-events";
import type { WorkflowNode } from "@bridge/contracts/c5-workflow";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";

import type { WorkflowDraftTestResult } from "../../api/client/types";
import { Badge, Button, SelectInput, TextAreaInput } from "../../shared/ui-kit";

export interface TestRunPanelProps {
  /** Точки входа схемы 2.0: прогон начинается со сработавшего wait-event. */
  waitEventNodes: readonly WorkflowNode[];
  onRun: (nodeId: string, payload: Record<string, unknown>) => void;
  result: WorkflowDraftTestResult | null;
  error: string;
  running: boolean;
  onSelectNode: (nodeId: string) => void;
}

/**
 * Тест-прогон драфта (дефект D5, решения A5/A6).
 *
 * Прежний «тест» печатал `completed` для каждого узла в порядке массива. Здесь
 * драфт исполняет настоящий движок, а панель показывает трассу — включая ту, что
 * пришла с падением: по ней видно, до какого узла дошли.
 *
 * Нагрузка события редактируется вручную с предзаполнением образца из реестра:
 * без этого ветвления на разных данных не проверить (решение A6).
 */
export function TestRunPanel({
  error,
  onRun,
  onSelectNode,
  result,
  running,
  waitEventNodes,
}: TestRunPanelProps) {
  const [nodeId, setNodeId] = useState<string>(() => waitEventNodes[0]?.id ?? "");
  const [payloadText, setPayloadText] = useState<string>("{}");
  const [payloadError, setPayloadError] = useState<string>("");

  // Смена узла — смена события: подставляем образец нагрузки именно его события.
  useEffect(() => {
    const node = waitEventNodes.find((item) => item.id === nodeId);
    const eventType = typeof node?.config?.event_type === "string" ? node.config.event_type : "";
    const definition = eventType ? getWorkflowEventDefinition(eventType) : null;
    setPayloadText(JSON.stringify(definition?.sample_payload ?? {}, null, 2));
    setPayloadError("");
  }, [nodeId, waitEventNodes]);

  useEffect(() => {
    if (nodeId === "" && waitEventNodes.length > 0) setNodeId(waitEventNodes[0].id);
  }, [nodeId, waitEventNodes]);

  const run = (): void => {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setPayloadError("Нагрузка события должна быть JSON-объектом.");
        return;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      setPayloadError("Не удалось разобрать JSON нагрузки.");
      return;
    }
    setPayloadError("");
    onRun(nodeId, payload);
  };

  if (waitEventNodes.length === 0) {
    return (
      <p className="wf-hint" data-testid="workflow-test-no-entry">
        Прогон начинается с узла «Ожидание события» — точки входа схемы. Добавьте такой узел.
      </p>
    );
  }

  return (
    <div className="wf-test" data-testid="workflow-test-panel">
      <SelectInput
        id="wf-test-node"
        label="Начать с узла"
        onChange={(event) => setNodeId(event.currentTarget.value)}
        options={waitEventNodes.map((node) => ({
          label: `${node.label || node.id} · ${eventLabel(node)}`,
          value: node.id,
        }))}
        value={nodeId}
      />

      <TextAreaInput
        error={payloadError}
        id="wf-test-payload"
        label="Полезная нагрузка события"
        onChange={(event) => setPayloadText(event.currentTarget.value)}
        rows={8}
        value={payloadText}
      />

      <Button disabled={running || nodeId === ""} onClick={run} type="button">
        <Play aria-hidden="true" size={16} />
        {running ? "Прогон идёт…" : "Прогнать драфт"}
      </Button>

      {error ? <p className="wf-error">{error}</p> : null}

      {result ? <TraceTable onSelectNode={onSelectNode} result={result} /> : null}
    </div>
  );
}

function TraceTable({
  onSelectNode,
  result,
}: {
  onSelectNode: (nodeId: string) => void;
  result: WorkflowDraftTestResult;
}) {
  return (
    <div className="wf-trace" data-testid="workflow-test-trace">
      <div className="wf-trace-summary">
        <Badge tone={result.status === "completed" ? "success" : "warning"}>
          {result.status === "completed" ? "Прогон завершён" : "Прогон оборвался"}
        </Badge>
        <span className="wf-hint">Шагов: {result.trace.length}</span>
      </div>

      {result.error ? (
        <p className="wf-error" data-testid="workflow-test-error">
          {String(result.error.message ?? "Ошибка исполнения")}
          {result.error.node_id ? ` (узел ${String(result.error.node_id)})` : ""}
        </p>
      ) : null}

      <table className="wf-trace-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Узел</th>
            <th>Как</th>
            <th>Время</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {result.trace.map((entry, index) => (
            <tr
              className={entry.failed ? "wf-trace-row-failed" : undefined}
              data-testid={`wf-trace-row-${entry.nodeId}`}
              key={`${entry.nodeId}-${index}`}
              onClick={() => onSelectNode(entry.nodeId)}
            >
              <td>{index + 1}</td>
              <td>
                {/* Вложенность субсхем — префиксом: отдельного дерева не нужно. */}
                {"↳ ".repeat(entry.depth)}
                {entry.nodeId}
              </td>
              <td title={entry.via === "flow" ? "по exec-связи" : "вычислен по требованию"}>
                {entry.via === "flow" ? "поток" : "данные"}
              </td>
              <td>{entry.durationMs} мс</td>
              <td>{entry.failed ? "ошибка" : "ок"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function eventLabel(node: WorkflowNode): string {
  const eventType = typeof node.config?.event_type === "string" ? node.config.event_type : "";
  if (eventType === "") return "событие не выбрано";
  const definition = WORKFLOW_EVENT_DEFINITIONS.find((item) => item.event_type === eventType);
  return definition?.label ?? eventType;
}
