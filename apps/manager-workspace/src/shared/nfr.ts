export type ManagerWorkspaceNfrOperation = "conversation_list" | "message_history" | "send_message";

export interface ManagerWorkspaceNfrMeasurement {
  operation: ManagerWorkspaceNfrOperation;
  budgetMs: number;
  durationMs: number;
  withinBudget: boolean;
  measuredAt: string;
}

export interface ManagerWorkspaceNfrSink {
  enabled?: boolean;
  measurements?: ManagerWorkspaceNfrMeasurement[];
  onMeasure?: (measurement: ManagerWorkspaceNfrMeasurement) => void;
}

export const MANAGER_WORKSPACE_NFR_BUDGET_MS = {
  conversation_list: 1000,
  message_history: 2000,
  send_message: 1000
} as const satisfies Record<ManagerWorkspaceNfrOperation, number>;

declare global {
  // Opt-in sink for acceptance probes and local diagnostics. Production stays silent by default.
  // eslint-disable-next-line no-var
  var __BRIDGE_MWS_NFR__: ManagerWorkspaceNfrSink | undefined;

  interface Window {
    __BRIDGE_MWS_NFR__?: ManagerWorkspaceNfrSink;
  }
}

export function startClientNfrMeasurement() {
  return now();
}

export function recordClientNfrMeasurement(
  operation: ManagerWorkspaceNfrOperation,
  budgetMs: number,
  startedAt: number
) {
  const sink = getNfrSink();

  if (!sink?.enabled) {
    return;
  }

  const durationMs = Math.round((now() - startedAt) * 10) / 10;
  const measurement: ManagerWorkspaceNfrMeasurement = {
    operation,
    budgetMs,
    durationMs,
    withinBudget: durationMs <= budgetMs,
    measuredAt: new Date().toISOString()
  };

  sink.measurements ??= [];
  sink.measurements.push(measurement);
  sink.onMeasure?.(measurement);
}

function getNfrSink() {
  return globalThis.__BRIDGE_MWS_NFR__;
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
