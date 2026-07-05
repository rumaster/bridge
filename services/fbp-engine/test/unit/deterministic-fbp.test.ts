import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeterministicFbpMock } from "../../src/deterministic-fbp.js";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

const startRequest = {
  contract: "C5.StartWorkflowInstanceRequest",
  version: "1.0.0",
  request_id: "req-workflow-start-1",
  organization_id: "org-1",
  workflow_version_id: "workflow-version-1",
  input: {
    conversation_id: "conversation-1",
  },
  context: {
    organization_id: "org-1",
    actor_user_id: "manager-1",
    trigger: "manual",
  },
};

describe("deterministic FBP M0 mock", () => {
  it("starts a workflow with deterministic instance id and state", () => {
    const fbp = createDeterministicFbpMock({ now: fixedNow });

    const first = fbp.startWorkflow("workflow-1", startRequest);
    const second = fbp.startWorkflow("workflow-1", startRequest);

    assert.equal(first.instance_id, second.instance_id);
    assert.equal(first.status, "started");
    assert.equal(first.state.status, "started");
    assert.equal(first.state.workflow_version_id, "workflow-version-1");
    assert.equal(first.state_changed_event.event, "workflow.state_changed");
    assert.equal(first.created_at, "2026-07-02T16:30:00.000Z");
  });

  it("records a Backend API node callback as a stubbed response", () => {
    const fbp = createDeterministicFbpMock({ now: fixedNow });
    const started = fbp.startWorkflow("workflow-1", startRequest);

    const callback = fbp.recordBackendApiCallback({
      contract: "C5.BackendApiNodeCallbackRequest",
      version: "1.0.0",
      request_id: "req-callback-1",
      organization_id: "org-1",
      workflow_id: "workflow-1",
      workflow_version_id: "workflow-version-1",
      instance_id: started.instance_id,
      node_id: "backend-api-node-1",
      context: startRequest.context,
      backend_request: {
        method: "POST",
        path: "/api/v1/messages",
        body: {
          text: "Ответ из workflow",
        },
      },
    });

    assert.equal(callback.accepted, true);
    assert.equal(callback.backend_response.status_code, 200);
    assert.equal(callback.state.status, "callback_recorded");
    assert.equal(fbp.getMetrics().backend_api_callback_total, 1);
  });
});
