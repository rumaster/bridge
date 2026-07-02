import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./c4.mjs";

export const C5_VERSION = "1.0.0";

export const WORKFLOW_INSTANCE_STATUSES = Object.freeze([
  "created",
  "started",
  "running",
  "waiting",
  "callback_recorded",
  "completed",
  "failed",
  "cancelled",
  "degraded",
]);

export const WORKFLOW_STATE_CHANGED_EVENT_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../events/workflow-state-changed.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function createWorkflowStateChangedEvent({
  eventId,
  organizationId,
  workflowId,
  workflowVersionId,
  instanceId,
  previousStatus = null,
  status,
  changedAt = new Date().toISOString(),
  reason,
}) {
  if (!WORKFLOW_INSTANCE_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported workflow instance status: ${status}`);
  }

  if (
    previousStatus !== null &&
    !WORKFLOW_INSTANCE_STATUSES.includes(previousStatus)
  ) {
    throw new TypeError(`Unsupported previous workflow instance status: ${previousStatus}`);
  }

  return {
    contract: "C7.WorkflowStateChangedEvent",
    version: C5_VERSION,
    event: "workflow.state_changed",
    event_id: eventId,
    organization_id: organizationId,
    workflow_id: workflowId,
    workflow_version_id: workflowVersionId,
    instance_id: instanceId,
    previous_status: previousStatus,
    status,
    changed_at: changedAt,
    ...(reason ? { reason } : {}),
  };
}

export function validateWorkflowStateChangedEvent(event) {
  return validateJsonSchema(event, WORKFLOW_STATE_CHANGED_EVENT_SCHEMA);
}
