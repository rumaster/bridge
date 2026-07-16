import { getFbpNodePortDefinition, portColor } from "@bridge/contracts/c5-workflow";
import type { WorkflowSchema } from "@bridge/contracts/c5-workflow";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";

import {
  GraphOperationError,
  canConnectGraphPorts,
  connectGraphPorts,
  moveGraphNode,
  removeGraphConnections,
  removeGraphNodes,
} from "./graph-ops";
import { WorkflowNodeCard } from "./WorkflowNodeCard";
import type { WorkflowNodeCardData } from "./WorkflowNodeCard";

const NODE_TYPES = { workflow: WorkflowNodeCard };

export interface WorkflowCanvasProps {
  graph: WorkflowSchema;
  onChange: (next: WorkflowSchema) => void;
  onError: (message: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  /** Узлы последнего тест-прогона: пройденные подсвечиваются, упавший — отдельно. */
  visitedNodeIds?: readonly string[];
  failedNodeId?: string | null;
  readOnly?: boolean;
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  // ReactFlowProvider нужен из-за useUpdateNodeInternals в узле: хук работает
  // только внутри провайдера.
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner({
  failedNodeId = null,
  graph,
  onChange,
  onError,
  onSelectNode,
  readOnly = false,
  selectedNodeId,
  visitedNodeIds = [],
}: WorkflowCanvasProps) {
  const visited = useMemo(() => new Set(visitedNodeIds), [visitedNodeIds]);

  const nodes = useMemo<Node<WorkflowNodeCardData>[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: node.position,
        selected: node.id === selectedNodeId,
        data: {
          failed: node.id === failedNodeId,
          graph,
          node,
          visited: visited.has(node.id),
        },
      })),
    [failedNodeId, graph, selectedNodeId, visited],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.connections.map((connection) => {
        const from = graph.nodes.find((node) => node.id === connection.from);
        // Цвет ребра — цвет его порта: exec-поток и данные должны различаться
        // взглядом, без чтения подписей.
        const port = from
          ? getFbpNodePortDefinition(from, "output", connection.fromPort, graph)
          : null;
        const color = portColor(port?.type ?? "any");

        return {
          id: connection.id,
          source: connection.from,
          sourceHandle: connection.fromPort,
          target: connection.to,
          targetHandle: connection.toPort,
          style: { stroke: color, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [graph],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      try {
        onChange(connectGraphPorts(graph, connection));
        onError("");
      } catch (error) {
        // Причина отказа приходит из контракта — редактор её не сочиняет.
        onError(
          error instanceof GraphOperationError ? error.message : "Не удалось соединить порты",
        );
      }
    },
    [graph, onChange, onError],
  );

  /**
   * Подсветка допустимых целей во время перетаскивания. Та же проверка, что и в
   * `onConnect`, — иначе подсветка обещала бы одно, а отпускание давало другое.
   */
  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      canConnectGraphPorts(graph, {
        source: connection.source ?? null,
        sourceHandle: connection.sourceHandle ?? null,
        target: connection.target ?? null,
        targetHandle: connection.targetHandle ?? null,
      }).valid,
    [graph],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<WorkflowNodeCardData>>[]) => {
      if (readOnly) return;
      let next = graph;

      for (const change of changes) {
        if (change.type === "position" && change.position) {
          next = moveGraphNode(next, change.id, change.position);
        }
        if (change.type === "remove") {
          next = removeGraphNodes(next, [change.id]);
          if (change.id === selectedNodeId) onSelectNode(null);
        }
        if (change.type === "select" && change.selected) {
          onSelectNode(change.id);
        }
      }

      if (next !== graph) onChange(next);
    },
    [graph, onChange, onSelectNode, readOnly, selectedNodeId],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (readOnly) return;
      onChange(removeGraphConnections(graph, deleted.map((edge) => edge.id)));
    },
    [graph, onChange, readOnly],
  );

  return (
    <div className="wf-canvas" data-testid="workflow-canvas">
      <ReactFlow
        edges={edges}
        edgesReconnectable={!readOnly}
        fitView
        isValidConnection={isValidConnection}
        nodes={nodes}
        nodeTypes={NODE_TYPES}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        onConnect={readOnly ? undefined : handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onNodesChange={handleNodesChange}
        onPaneClick={() => onSelectNode(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
