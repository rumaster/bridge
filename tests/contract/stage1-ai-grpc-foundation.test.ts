import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeterministicAiMock } from "../../services/ai-platform/src/deterministic-ai.js";
import { startAiPlatformGrpcServer } from "../../services/ai-platform/src/grpc-server.js";
import { AiGrpcUpstreamClient } from "../../services/backend/src/modules/ai-integration/ai-grpc-upstream.client.js";

describe("Stage 1 DR-01 Backend to SVC-AI gRPC foundation", () => {
  it("passes a C4 assistant request over the shared proto contract", async () => {
    const handle = await startAiPlatformGrpcServer({
      ai: createDeterministicAiMock({ now: () => "2026-07-05T23:30:00.000Z" }),
      host: "127.0.0.1",
      port: 0,
    });
    const client = new AiGrpcUpstreamClient({ target: `127.0.0.1:${handle.port}` });

    try {
      const response = await client.suggestAssistant({
        organization_id: "org-stage-1",
        query: "Как оформить возврат?",
        request_id: "req-stage-1",
      });

      assert.equal(response.contract, "C4.AssistantSuggestResponse");
      assert.equal(response.request_id, "req-stage-1");
      assert.equal(response.organization_id, "org-stage-1");
      assert.equal(response.degraded, false);
      assert.equal(response.fallback_reason, null);
      assert.equal(response.suggestion.mode, "generated");
      assert.match(response.suggestion.text, /возврат/i);

      const health = await client.getHealth();
      assert.equal(health.status, "ok");
      assert.equal(health.contract, "C4");
    } finally {
      client.onModuleDestroy();
      await new Promise<void>((resolveShutdown) => {
        handle.server.tryShutdown(() => resolveShutdown());
      });
    }
  });
});
