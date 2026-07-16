import { FbpIntegrationFacade } from "../../src/modules/fbp-integration/fbp-integration.facade";
import type {
  FbpStartWorkflowFacadeResponse,
  FbpTestDraftFacadeResponse,
} from "../../src/modules/fbp-integration/fbp-integration.facade";

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

  /**
   * Тест-прогон драфта (дефект D5). Единственный вызов фасада, который НЕ
   * деградирует: заглушка со статусом означала бы «схема работает», хотя её никто
   * не исполнял.
   */
  describe("testWorkflowDraft", () => {
    const request = {
      actor_user_id: "user-1",
      event_payload: { text: "привет" },
      organization_id: "org-1",
      request_id: "req-draft-test-1",
      start_node_id: "wait-message",
      workflow_id: "workflow-1",
    };

    it("passes the engine trace through untouched", async () => {
      const facade = new FbpIntegrationFacade();
      const response: FbpTestDraftFacadeResponse = {
        contract: "C5.TestWorkflowDraftResponse",
        version: "1.0.0",
        request_id: "req-draft-test-1",
        organization_id: "org-1",
        workflow_id: "workflow-1",
        status: "completed",
        output: { ok: true },
        error: null,
        trace: [
          {
            nodeId: "wait-message",
            type: "wait-event",
            via: "flow",
            durationMs: 3,
            inputs: {},
            outputs: { data: { text: "привет" } },
            failed: false,
            nodePath: ["wait-message"],
            depth: 0,
          },
        ],
        created_at: "2026-07-02T16:30:00.000Z",
      };

      await expect(
        facade.testWorkflowDraft(request, { call: async () => response, now: fixedNow }),
      ).resolves.toEqual(response);
    });

    it("passes a failed run through as a result, not as an error", async () => {
      // Драфт валиден только по форме графа (решение A10), поэтому падение на
      // полпути — нормальный исход прогона: трасса покажет, где именно.
      const facade = new FbpIntegrationFacade();
      const response: FbpTestDraftFacadeResponse = {
        contract: "C5.TestWorkflowDraftResponse",
        version: "1.0.0",
        request_id: "req-draft-test-1",
        organization_id: "org-1",
        workflow_id: "workflow-1",
        status: "failed",
        output: null,
        error: { reason: "error", message: "взорвалось", node_id: "boom", node_type: "transform" },
        trace: [],
        created_at: "2026-07-02T16:30:00.000Z",
      };

      await expect(
        facade.testWorkflowDraft(request, { call: async () => response, now: fixedNow }),
      ).resolves.toMatchObject({ status: "failed" });
    });

    it("reports an unavailable engine as 503 instead of degrading to a stub", async () => {
      // upstream = null. Боевой старт здесь вернул бы заглушку, чтобы сообщения
      // продолжали ходить; тест-прогон обязан сказать правду — иначе оператор
      // прочитает «движок лежит» как «схема прошла».
      const facade = new FbpIntegrationFacade();

      await expect(facade.testWorkflowDraft(request, { now: fixedNow })).rejects.toMatchObject({
        response: { code: "WORKFLOW_ENGINE_UNAVAILABLE" },
        status: 503,
      });
    });

    it("reports a timeout as 503 as well", async () => {
      const facade = new FbpIntegrationFacade();

      await expect(
        facade.testWorkflowDraft(request, {
          call: () => new Promise(() => undefined),
          timeoutMs: 1,
          now: fixedNow,
        }),
      ).rejects.toMatchObject({
        response: { code: "WORKFLOW_ENGINE_UNAVAILABLE" },
        status: 503,
      });
    });
  });
});
