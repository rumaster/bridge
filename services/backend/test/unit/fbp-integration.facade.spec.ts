import { FbpIntegrationFacade } from "../../src/modules/fbp-integration/fbp-integration.facade";
import type { FbpStartWorkflowFacadeResponse } from "../../src/modules/fbp-integration/fbp-integration.facade";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("FbpIntegrationFacade", () => {
  it("passes through a successful FBP workflow start response", async () => {
    const facade = new FbpIntegrationFacade();
    const response: FbpStartWorkflowFacadeResponse = {
      contract: "C5.StartWorkflowInstanceResponse",
      version: "1.0.0",
      request_id: "req-workflow-start-1",
      organization_id: "org-1",
      workflow_id: "workflow-1",
      workflow_version_id: "workflow-version-1",
      instance_id: "instance-1",
      status: "started",
      degraded: false,
      fallback_reason: null,
      state: {
        status: "started",
      },
      state_changed_event: null,
      created_at: "2026-07-02T16:30:00.000Z",
    };

    await expect(
      facade.startWorkflowInstance(
        {
          request_id: "req-workflow-start-1",
          organization_id: "org-1",
          workflow_id: "workflow-1",
          workflow_version_id: "workflow-version-1",
          actor_user_id: "manager-1",
        },
        {
          call: async () => response,
          now: fixedNow,
        },
      ),
    ).resolves.toBe(response);
  });

  it("returns controlled degraded fallback when FBP has no callable client", async () => {
    const facade = new FbpIntegrationFacade();

    await expect(
      facade.startWorkflowInstance(
        {
          request_id: "req-workflow-start-1",
          organization_id: "org-1",
          workflow_id: "workflow-1",
          workflow_version_id: "workflow-version-1",
          actor_user_id: "manager-1",
        },
        { now: fixedNow },
      ),
    ).resolves.toMatchObject({
      contract: "C5.StartWorkflowInstanceResponse",
      degraded: true,
      fallback_reason: "unavailable",
      status: "degraded",
      state: {
        status: "degraded",
      },
      created_at: "2026-07-02T16:30:00.000Z",
    });
  });
});
