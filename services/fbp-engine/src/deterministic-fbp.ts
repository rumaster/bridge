import { createHash } from "node:crypto";

import {
  C5_VERSION,
  createWorkflowStateChangedEvent,
} from "../../../packages/contracts/src/c5.js";
import {
  assertBackendApiCallbackRequest,
  assertStartWorkflowInstanceRequest,
} from "./c5-dto.js";

export function createDeterministicFbpMock({
  now = () => new Date().toISOString(),
} = {}) {
  const instances = new Map();
  const metrics = {
    workflow_start_total: 0,
    backend_api_callback_total: 0,
  };

  return {
    startWorkflow(workflowId, payload) {
      const request = assertStartWorkflowInstanceRequest(payload);
      const instanceId = createDeterministicUuid([
        request.organization_id,
        workflowId,
        request.workflow_version_id,
        request.request_id,
      ]);
      const createdAt = now();
      const state = {
        status: "started",
        workflow_id: workflowId,
        workflow_version_id: request.workflow_version_id,
        current_node_id: null,
        input: request.input,
        context: request.context,
        backend_api_callback: {
          mode: "stub",
          path: `/api/v1/workflows/${workflowId}/instances/${instanceId}/backend-api-callbacks`,
        },
      };
      const stateChangedEvent = createWorkflowStateChangedEvent({
        eventId: `${instanceId}:started`,
        organizationId: request.organization_id,
        workflowId,
        workflowVersionId: request.workflow_version_id,
        instanceId,
        previousStatus: "created",
        status: "started",
        changedAt: createdAt,
        reason: "mock_started",
      });

      metrics.workflow_start_total += 1;
      instances.set(instanceId, state);

      return {
        contract: "C5.StartWorkflowInstanceResponse",
        version: C5_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        workflow_id: workflowId,
        workflow_version_id: request.workflow_version_id,
        instance_id: instanceId,
        status: "started",
        degraded: false,
        fallback_reason: null,
        state,
        state_changed_event: stateChangedEvent,
        created_at: createdAt,
      };
    },

    recordBackendApiCallback(payload) {
      const request = assertBackendApiCallbackRequest(payload);
      const createdAt = now();
      const state = {
        status: "callback_recorded",
        workflow_id: request.workflow_id,
        workflow_version_id: request.workflow_version_id,
        instance_id: request.instance_id,
        last_node_id: request.node_id,
        backend_request: request.backend_request,
      };

      metrics.backend_api_callback_total += 1;
      instances.set(request.instance_id, state);

      return {
        contract: "C5.BackendApiNodeCallbackResponse",
        version: C5_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        workflow_id: request.workflow_id,
        workflow_version_id: request.workflow_version_id,
        instance_id: request.instance_id,
        node_id: request.node_id,
        accepted: true,
        backend_response: {
          status_code: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
          body: {
            mock: true,
            callback_id: createDeterministicUuid([
              request.organization_id,
              request.instance_id,
              request.node_id,
              request.request_id,
            ]),
            received_method: request.backend_request.method,
            received_path: request.backend_request.path,
          },
        },
        state,
        created_at: createdAt,
      };
    },

    getInstanceState(instanceId) {
      return instances.get(instanceId) ?? null;
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function createDeterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
