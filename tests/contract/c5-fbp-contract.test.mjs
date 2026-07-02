import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createWorkflowStateChangedEvent,
  validateWorkflowStateChangedEvent,
} from "../../packages/contracts/src/c5.mjs";
import { createFbpEngineServer } from "../../services/fbp-engine/src/server.mjs";

const root = process.cwd();
const fixedNow = () => "2026-07-02T16:30:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("API <-> FBP M0 C5 contract", () => {
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

  it("publishes the frozen C5 OpenAPI operations", () => {
    const openApi = readJson("packages/contracts/openapi/fbp/c5.fbp.openapi.json");

    assert.equal(openApi["x-contract-id"], "C5");
    assert.equal(openApi["x-owner"], "SVC-FBP");
    assert.equal(openApi.info.version, "1.0.0");
    assert.deepEqual(openApi.servers, [{ url: "/api/v1" }]);
    assert.ok(openApi.paths["/workflows/{id}/instances"].post);
    assert.ok(
      openApi.paths["/workflows/{id}/instances/{instance_id}/backend-api-callbacks"].post,
    );
  });

  it("freezes workflow.state_changed as a C7 event schema owned by FBP", () => {
    const schema = readJson("packages/contracts/events/workflow-state-changed.schema.json");
    const event = createWorkflowStateChangedEvent({
      eventId: "workflow-instance-1:started",
      organizationId: "org-1",
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      instanceId: "workflow-instance-1",
      previousStatus: "created",
      status: "started",
      changedAt: "2026-07-02T16:30:00.000Z",
      reason: "mock_started",
    });

    const validation = validateWorkflowStateChangedEvent(event);

    assert.equal(schema.properties.event.const, "workflow.state_changed");
    assert.equal(schema["x-owner"], "SVC-FBP");
    assert.equal(validation.valid, true);
  });

  it("smokes the API -> FBP start and callback exchange against the mock provider", async () => {
    const startResponse = await fetch(`${baseUrl}/api/v1/workflows/workflow-1/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract: "C5.StartWorkflowInstanceRequest",
        version: "1.0.0",
        request_id: "req-workflow-contract-1",
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

    assert.equal(startResponse.status, 201);
    assert.equal(started.contract, "C5.StartWorkflowInstanceResponse");
    assert.equal(started.status, "started");

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
          request_id: "req-callback-contract-1",
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
    assert.equal(callback.backend_response.body.mock, true);
  });
});
