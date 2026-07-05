import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createFbpEngineServer } from "../../src/server.js";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("FBP Engine M0 mock server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createFbpEngineServer({ now: fixedNow });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("starts a workflow instance through the frozen C5 endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/v1/workflows/workflow-1/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract: "C5.StartWorkflowInstanceRequest",
        version: "1.0.0",
        request_id: "req-workflow-start-1",
        organization_id: "org-1",
        workflow_version_id: "workflow-version-1",
        context: {
          organization_id: "org-1",
          actor_user_id: "manager-1",
          trigger: "manual",
        },
      }),
    });

    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.contract, "C5.StartWorkflowInstanceResponse");
    assert.equal(body.workflow_id, "workflow-1");
    assert.equal(body.status, "started");
    assert.equal(body.state_changed_event.event, "workflow.state_changed");
  });

  it("exposes a Backend API callback stub for contract smoke", async () => {
    const startResponse = await fetch(`${baseUrl}/api/v1/workflows/workflow-1/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract: "C5.StartWorkflowInstanceRequest",
        version: "1.0.0",
        request_id: "req-workflow-start-2",
        organization_id: "org-1",
        workflow_version_id: "workflow-version-1",
        context: {
          organization_id: "org-1",
          actor_user_id: "manager-1",
          trigger: "manual",
        },
      }),
    });
    const started = await startResponse.json();

    const callbackResponse = await fetch(
      `${baseUrl}/api/v1/workflows/workflow-1/instances/${started.instance_id}/backend-api-callbacks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contract: "C5.BackendApiNodeCallbackRequest",
          version: "1.0.0",
          request_id: "req-callback-1",
          organization_id: "org-1",
          workflow_id: "workflow-1",
          workflow_version_id: "workflow-version-1",
          instance_id: started.instance_id,
          node_id: "backend-api-node-1",
          context: {
            organization_id: "org-1",
            actor_user_id: "manager-1",
            trigger: "manual",
          },
          backend_request: {
            method: "POST",
            path: "/api/v1/messages",
          },
        }),
      },
    );
    const callback = await callbackResponse.json();

    assert.equal(callbackResponse.status, 200);
    assert.equal(callback.contract, "C5.BackendApiNodeCallbackResponse");
    assert.equal(callback.accepted, true);
    assert.equal(callback.backend_response.body.mock, true);
  });
});
