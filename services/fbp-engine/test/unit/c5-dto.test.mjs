import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateBackendApiCallbackRequest,
  validateStartWorkflowInstanceRequest,
} from "../../src/c5-dto.mjs";

describe("C5 FBP DTO validators", () => {
  it("accepts the frozen workflow start DTO", () => {
    const result = validateStartWorkflowInstanceRequest({
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
        roles: ["administrator"],
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.input, {
      conversation_id: "conversation-1",
    });
  });

  it("rejects start DTOs that do not carry tenant context", () => {
    const result = validateStartWorkflowInstanceRequest({
      contract: "C5.StartWorkflowInstanceRequest",
      version: "1.0.0",
      request_id: "req-workflow-start-1",
      organization_id: "org-1",
      workflow_version_id: "workflow-version-1",
      context: {
        actor_user_id: "manager-1",
        trigger: "manual",
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /context\.organization_id/);
  });

  it("accepts the Backend API node callback DTO", () => {
    const result = validateBackendApiCallbackRequest({
      contract: "C5.BackendApiNodeCallbackRequest",
      version: "1.0.0",
      request_id: "req-callback-1",
      organization_id: "org-1",
      workflow_id: "workflow-1",
      workflow_version_id: "workflow-version-1",
      instance_id: "instance-1",
      node_id: "backend-api-node-1",
      context: {
        organization_id: "org-1",
        actor_user_id: "manager-1",
        trigger: "manual",
      },
      backend_request: {
        method: "POST",
        path: "/api/v1/messages",
        headers: {
          "idempotency-key": "callback-idempotency-1",
        },
        body: {
          text: "Ответ из workflow",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.backend_request.method, "POST");
  });

  it("rejects callback DTOs that try to bypass Backend API", () => {
    const result = validateBackendApiCallbackRequest({
      contract: "C5.BackendApiNodeCallbackRequest",
      version: "1.0.0",
      request_id: "req-callback-1",
      organization_id: "org-1",
      workflow_id: "workflow-1",
      workflow_version_id: "workflow-version-1",
      instance_id: "instance-1",
      node_id: "backend-api-node-1",
      context: {
        organization_id: "org-1",
        actor_user_id: "manager-1",
        trigger: "manual",
      },
      backend_request: {
        method: "POST",
        path: "postgres://bridge/workflows",
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /backend_request\.path/);
  });
});
