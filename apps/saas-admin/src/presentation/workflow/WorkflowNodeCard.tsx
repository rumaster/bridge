import { getNodePortDefinitions, portColor } from "@bridge/contracts/c5-workflow";
import type { FbpNodePortDefinition, WorkflowNode, WorkflowSchema } from "@bridge/contracts/c5-workflow";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, useRef } from "react";

import { workflowNodeMutatesData, workflowNodeTypeLabel } from "../../shared/workflow";
import { portSignature } from "./graph-ops";

export interface WorkflowNodeCardData {
  node: WorkflowNode;
  graph: WorkflowSchema;
  /** Узел, на котором прогон оборвался: подсвечивается отдельно от выделения. */
  failed: boolean;
  /** Узел исполнялся в последнем тест-прогоне. */
  visited: boolean;
  [key: string]: unknown;
}

/**
 * Узел на холсте. Порты рисуются ИЗ КОНТРАКТА — `getNodePortDefinitions(node, graph)`,
 * та же функция, которой пользуются Backend и движок. Поэтому редактор физически
 * не может нарисовать порт, которого не будет в рантайме.
 */
export function WorkflowNodeCard({ data, selected }: { data: WorkflowNodeCardData; selected?: boolean }) {
  const { node, graph, failed, visited } = data;
  const ports = getNodePortDefinitions(node, graph);
  const signature = portSignature(graph, node);

  useHandleReregistration(node.id, signature);

  const classes = ["wf-node"];
  if (selected) classes.push("wf-node-selected");
  if (failed) classes.push("wf-node-failed");
  else if (visited) classes.push("wf-node-visited");

  return (
    <div className={classes.join(" ")} data-testid={`wf-node-${node.id}`}>
      <div className="wf-node-header">
        <span className="wf-node-title">{node.label || node.id}</span>
        <span className="wf-node-type">{workflowNodeTypeLabel(node.type as never)}</span>
        {workflowNodeMutatesData(node.type as never) ? (
          <span className="wf-node-mutates" title="Узел изменяет данные (ТЗ §13.5)">
            Изменяет данные
          </span>
        ) : null}
      </div>
      <div className="wf-node-ports">
        <NodePorts ports={ports.inputs} side="input" nodeId={node.id} />
        <NodePorts ports={ports.outputs} side="output" nodeId={node.id} />
      </div>
    </div>
  );
}

/**
 * Перерегистрация хэндлов при смене состава портов.
 *
 * xyflow измеряет хэндлы один раз и не замечает, что порты сменились, если
 * габариты узла остались прежними (xyflow#394). Без этого переименование порта в
 * панели свойств оставляет связь висеть на старой координате.
 *
 * На первом рендере не зовём: `updateNodeInternals` сбрасывает измерения, а до
 * первого измерения сбрасывать нечего — лишний вызов только ломает выделение
 * рамкой.
 */
function useHandleReregistration(nodeId: string, signature: string): void {
  const updateNodeInternals = useUpdateNodeInternals();
  const previous = useRef(signature);

  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    updateNodeInternals(nodeId);
  }, [nodeId, signature, updateNodeInternals]);
}

function NodePorts({
  nodeId,
  ports,
  side,
}: {
  nodeId: string;
  ports: FbpNodePortDefinition[];
  side: "input" | "output";
}) {
  return (
    <div className={`wf-ports wf-ports-${side}`}>
      {ports.map((port) => {
        const color = portColor(port.type);
        const handle = (
          <Handle
            className="wf-handle"
            id={port.id}
            position={side === "input" ? Position.Left : Position.Right}
            style={{ background: color, borderColor: color }}
            type={side === "input" ? "target" : "source"}
            // Порт и его тип — в data-атрибутах: по ним тест проверяет, что
            // редактор нарисовал ровно те порты, которые даёт контракт.
            data-port-id={port.id}
            data-port-type={port.type}
            data-testid={`wf-handle-${nodeId}-${side}-${port.id}`}
          />
        );
        const label = (
          <span className="wf-port-label" title={`${port.label} · ${port.type}`}>
            {port.label}
          </span>
        );

        return (
          <div className="wf-port-row" key={`${side}:${port.id}`}>
            {side === "input" ? handle : label}
            {side === "input" ? label : handle}
          </div>
        );
      })}
    </div>
  );
}
