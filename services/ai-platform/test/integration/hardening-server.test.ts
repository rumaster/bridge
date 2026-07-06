import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../../../packages/contracts/src/c4.js";
import { createCircuitBreaker } from "../../src/circuit-breaker.js";
import { createResilientLlm } from "../../src/llm-facade.js";
import { createAiMetrics } from "../../src/metrics.js";
import {
  createDeterministicMockLlm,
  createUnavailableLlm,
} from "../../src/llm.js";
import { createInMemoryKbSearch } from "../../src/kb-search.js";
import {
  createLlmProviderRegistry,
  createLlmRouter,
} from "../../src/provider-registry.js";
import { createRagAssistant } from "../../src/rag-assistant.js";
import { createAiPlatformServer } from "../../src/server.js";

const JSON_HEADERS = { "content-type": "application/json" };
const NOW = "2026-07-03T10:00:00.000Z";

const KB_CHUNKS = [
  {
    organization_id: "org-1",
    document_id: "doc-return",
    chunk_id: "chunk-return",
    chunk_no: 1,
    title: "Политика возврата",
    content: "Для возврата заказа уточните номер заказа и причину возврата.",
  },
  {
    organization_id: "org-2",
    document_id: "doc-secret",
    chunk_id: "chunk-secret",
    chunk_no: 1,
    title: "Возврат другой организации",
    content: "Секретная политика возврата заказа организации org-2.",
  },
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function suggest(baseUrl, organizationId, query) {
  return fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: `req-${organizationId}`,
      organization_id: organizationId,
      query,
    }),
  });
}

function onboard(baseUrl, organizationId, prompt) {
  return fetch(`${baseUrl}/api/v1/ai/onboarding:command`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: `req-${organizationId}`,
      organization_id: organizationId,
      actor_user_id: "admin-1",
      prompt,
    }),
  });
}

/**
 * Circuit breaker opening through the HTTP surface (ТЗ §11.2, §24.4). The LLM
 * always fails; after two suggestions the shared breaker opens, the third
 * suggestion is short-circuited, and both facts surface on /metrics and /health.
 */
describe("hardening — circuit breaker via the server", () => {
  let server;
  let baseUrl;

  before(async () => {
    const metrics = createAiMetrics();
    const breaker = createCircuitBreaker({ failureThreshold: 2, onOpen: () => metrics.inc("llm_circuit_open_total") });
    const resilient = createResilientLlm({
      provider: createUnavailableLlm({ reason: "unavailable" }),
      metrics,
      breaker,
    });
    const ai = createRagAssistant({
      llm: resilient,
      kbSearch: createInMemoryKbSearch({ chunks: KB_CHUNKS }),
      metrics,
      now: () => NOW,
    });
    server = createAiPlatformServer({ ai, mode: "rag", now: () => NOW });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("keeps returning a valid degraded stub while the provider is down", async () => {
    for (const query of ["возврат 1", "возврат 2", "возврат 3"]) {
      const response = await suggest(baseUrl, "org-1", query);
      assert.equal(response.status, 200);
      const body: any = await response.json();
      assert.equal(body.contract, "C4.AssistantSuggestResponse");
      assert.equal(body.degraded, true);
      assert.equal(body.suggestion.mode, "fallback");
    }
  });

  it("opens the breaker and short-circuits later calls (metrics)", async () => {
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /ai_platform_llm_circuit_open_total 1/);
    assert.match(metrics, /ai_platform_llm_short_circuit_total [1-9]/);
    assert.match(metrics, /ai_platform_llm_circuit_breaker_open 1/);
  });

  it("reports the open breaker on /health", async () => {
    const health: any = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.status, "ok", "service stays live even with the LLM down");
    assert.equal(health.llm.breaker.state, "open");
  });
});

/**
 * Provider/model selection by organization/platform config (ТЗ §12.9), exercised
 * end-to-end: org-1 gets the premium model, everyone else the economy default.
 * Both answer correctly and tenant isolation still holds through the router.
 */
describe("hardening — provider selection by config", () => {
  let server;
  let baseUrl;

  before(async () => {
    const metrics = createAiMetrics();
    const registry = createLlmProviderRegistry({
      economy: ({ model }) =>
        createDeterministicMockLlm({ name: "economy", model: model ?? "mock-economy", pricing: { default: 8 } }),
      premium: ({ model }) =>
        createDeterministicMockLlm({ name: "premium", model: model ?? "mock-premium", pricing: { default: 40 } }),
    });
    const router = createLlmRouter({
      registry,
      config: {
        default: { provider: "economy" },
        organizations: { "org-1": { provider: "premium", model: "mock-premium" } },
      },
      metrics,
    });
    const ai = createRagAssistant({
      resolveLlm: (organizationId) => router.resolve(organizationId),
      kbSearch: createInMemoryKbSearch({ chunks: KB_CHUNKS }),
      metrics,
      now: () => NOW,
    });
    server = createAiPlatformServer({ ai, mode: "rag", now: () => NOW });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("answers org-1 (premium) with real KB citations", async () => {
    const body: any = await (await suggest(baseUrl, "org-1", "Как оформить возврат заказа?")).json();
    assert.equal(body.degraded, false);
    assert.equal(body.source_status, "available");
    const ids = body.sources.map((source) => source.chunk_id);
    assert.ok(ids.includes("chunk-return"));
    assert.ok(!ids.includes("chunk-secret"), "tenant isolation holds under the router");
  });

  it("answers a default-tier org (economy) too", async () => {
    const body: any = await (await suggest(baseUrl, "org-1", "возврат")).json();
    assert.equal(body.contract, "C4.AssistantSuggestResponse");
    // org-2's private chunk must never leak into org-1's answer.
    const ids = body.sources.map((source) => source.chunk_id);
    assert.ok(!ids.includes("chunk-secret"));
  });

  it("reports the platform default provider on /health", async () => {
    const health: any = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.llm.name, "economy");
    assert.equal(health.llm.breaker.state, "closed");
  });

  it("accrues LLM call and cost metrics through the router", async () => {
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /ai_platform_llm_call_total [1-9]/);
    assert.match(metrics, /ai_platform_llm_cost_micros_total [1-9]/);
  });
});

/**
 * CP-9 e2e degradation: with AI completely unavailable the platform keeps
 * working — the Assistant returns a valid stub and Onboarding a safe noop, so the
 * communication core never stops (ТЗ §5.4, §25.4).
 */
describe("hardening — CP-9 degradation without stopping communication", () => {
  let server;
  let baseUrl;

  before(async () => {
    const ai = createRagAssistant({
      llm: createUnavailableLlm({ reason: "unavailable" }),
      kbSearch: createInMemoryKbSearch({ chunks: KB_CHUNKS }),
      now: () => NOW,
    });
    server = createAiPlatformServer({ ai, mode: "rag", now: () => NOW });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("Assistant returns a guaranteed stub answer", async () => {
    const body: any = await (await suggest(baseUrl, "org-1", "возврат заказа")).json();
    assert.equal(body.degraded, true);
    assert.equal(body.suggestion.mode, "fallback");
    assert.equal(body.fallback_reason, "unavailable");
    assert.match(body.suggestion.text, /вручную/);
  });

  it("Onboarding degrades to a valid safe noop command", async () => {
    const body: any = await (await onboard(baseUrl, "org-1", "Установи часовой пояс Europe/Moscow")).json();
    assert.equal(body.degraded, true);
    assert.equal(body.command.action, "noop");
    assert.equal(body.command.organization_id, "org-1");
    assert.equal(validateAiOnboardingCommand(body.command).valid, true);
  });

  it("stays live on /health and keeps serving /metrics", async () => {
    const health: any = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.status, "ok");
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /ai_platform_assistant_suggest_degraded_total [1-9]/);
    assert.match(metrics, /ai_platform_onboarding_command_degraded_total [1-9]/);
  });
});
