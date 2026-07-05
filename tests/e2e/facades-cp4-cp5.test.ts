import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../packages/contracts/src/c4.js";
import { createDeterministicAiMock } from "../../services/ai-platform/src/deterministic-ai.js";
import { createDeterministicFbpMock } from "../../services/fbp-engine/src/deterministic-fbp.js";

const fixedNow = () => "2026-07-03T10:00:00.000Z";
const ORG = "org-cp4-cp5";
const WORKFLOW = "workflow-cp4-cp5";

/**
 * CP-4/CP-5 facade e2e (Docker-free, contract-level). The DB-backed apply with
 * audit (`actor_type = ai|workflow`) is proven end-to-end against Postgres in
 * `services/backend/test/integration/m3-facades.spec.ts`; here we pin the
 * cross-service chain the Backend facades stitch together.
 */
describe("CP-4/CP-5 facade e2e (contract-level chain)", () => {
  it("CP-4: AI Onboarding produces a valid §12.6 config command for the Backend to apply", () => {
    const ai = createDeterministicAiMock({ now: fixedNow });

    const response: any = ai.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-onboarding-cp4",
      organization_id: ORG,
      actor_user_id: "manager-cp4",
      prompt: "Установи часовой пояс Europe/Moscow",
    });

    assert.equal(response.contract, "C4.OnboardingCommandResponse");
    assert.equal(response.degraded, false);
    assert.equal(response.command.action, "configuration.upsert");
    assert.equal(response.command.params.key, "organization.timezone");
    assert.equal(response.command.safety.apply_mode, "backend_validation_required");

    // The Backend applies the command only after this exact validation passes.
    const validation = validateAiOnboardingCommand(response.command);
    assert.equal(validation.valid, true, validation.errors?.join("; "));
  });

  it("CP-5: Workflow starts and drives the Backend API node exchange", () => {
    const fbp = createDeterministicFbpMock({ now: fixedNow });

    const started = fbp.startWorkflow(WORKFLOW, {
      contract: "C5.StartWorkflowInstanceRequest",
      version: "1.0.0",
      request_id: "req-workflow-cp5",
      organization_id: ORG,
      workflow_version_id: "workflow-version-cp5",
      context: {
        organization_id: ORG,
        actor_user_id: "manager-cp5",
        trigger: "manual",
      },
    });

    assert.equal(started.status, "started");
    assert.match(
      started.state.backend_api_callback.path,
      /\/api\/v1\/workflows\/.+\/instances\/.+\/backend-api-callbacks$/,
    );

    const callback = fbp.recordBackendApiCallback({
      contract: "C5.BackendApiNodeCallbackRequest",
      version: "1.0.0",
      request_id: "req-callback-cp5",
      organization_id: ORG,
      workflow_id: WORKFLOW,
      workflow_version_id: "workflow-version-cp5",
      instance_id: started.instance_id,
      node_id: "backend-api-node-1",
      context: {
        organization_id: ORG,
        actor_user_id: "manager-cp5",
        trigger: "workflow",
      },
      backend_request: {
        method: "POST",
        path: "/api/v1/workflows/backend-api-node:invoke",
      },
    });

    assert.equal(callback.accepted, true);
    assert.equal(callback.backend_response.status_code, 200);
    assert.equal(
      callback.backend_response.body.received_path,
      "/api/v1/workflows/backend-api-node:invoke",
    );
  });
});
