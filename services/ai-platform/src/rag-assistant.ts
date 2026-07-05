import {
  createAssistantSuggestResponse,
  validateAssistantSuggestResponse,
} from "../../../packages/contracts/src/c4.js";

import { assertAssistantSuggestRequest } from "./c4-dto.js";
import { createDeterministicMockLlm } from "./llm.js";
import { createResilientLlm } from "./llm-facade.js";
import { createAiMetrics } from "./metrics.js";
import { createOnboardingCommander } from "./onboarding.js";
import { buildPrompt, buildSources, rankChunks } from "./rag-pipeline.js";

const DEFAULT_TOP_K = 5;

/**
 * RAG-backed C4 AI Assistant (CP-3) — hardened for M5 (ТЗ §11.2, §22.6, §24.4).
 *
 * Flow (ТЗ §12.3, §12.7): embed the query through the swappable LLM abstraction →
 * ask Backend to search the Knowledge Base (C3.kb) under tenant isolation → rank
 * the returned chunks → generate an answer with source citations. Every LLM call
 * goes through the resilient facade (timeout + circuit breaker + metrics), and
 * any failure in the chain degrades to a safe fallback so messaging stays usable
 * (ТЗ §5.4): the response is still a valid C4 payload, just `degraded: true` with
 * `mode: "fallback"` and `source_status: "unavailable"`.
 *
 * When several providers/models are configured (ТЗ §12.9), pass a `resolveLlm`
 * router: the provider is chosen per request from the organization/platform
 * config. A bare `llm` is wrapped once in the resilient facade for the
 * single-provider case. Quality/cost signals land in a shared metrics sink
 * surfaced on `/metrics` (ТЗ §24.4).
 */
export function createRagAssistant({
  llm = createDeterministicMockLlm(),
  resolveLlm,
  kbSearch,
  topK = DEFAULT_TOP_K,
  now = () => new Date().toISOString(),
  metrics = createAiMetrics(),
  onboarding,
} = {}) {
  if (!kbSearch || typeof kbSearch.search !== "function") {
    throw new TypeError("createRagAssistant requires a kbSearch with a search() method");
  }

  // Single-provider path: wrap the given provider once so timeout, circuit
  // breaker and cost/latency metrics apply even when no router is configured.
  const singleLlm = llm.resilient ? llm : createResilientLlm({ provider: llm, metrics });
  const selectLlm =
    typeof resolveLlm === "function" ? resolveLlm : () => singleLlm;

  const commander =
    onboarding ??
    createOnboardingCommander({ resolveLlm: selectLlm, now, metrics });

  async function suggestAssistant(payload) {
    const request = assertAssistantSuggestRequest(payload);
    metrics.inc("assistant_suggest_total");

    try {
      const response = await runPipeline(request);
      assertValid(response);
      return response;
    } catch (error) {
      metrics.inc("assistant_suggest_degraded_total");
      const response = buildFallback(request, error);
      assertValid(response);
      return response;
    }
  }

  async function runPipeline(request) {
    const activeLlm = selectLlm(request.organization_id);
    const embedding = await activeLlm.embed(request.query);

    const { results } = await searchKb(request, embedding);

    const ranked = rankChunks(results, {
      organizationId: request.organization_id,
      topK,
    });

    // The prompt is built (and asserted) so tenant isolation is expressed in the
    // context handed to the model, even though the mock generates from `ranked`.
    buildPrompt({
      query: request.query,
      chunks: ranked,
      organizationId: request.organization_id,
    });

    const generated = await activeLlm.generate({
      query: request.query,
      chunks: ranked,
      organizationId: request.organization_id,
    });

    const sources = buildSources(ranked);

    return createAssistantSuggestResponse({
      requestId: request.request_id,
      organizationId: request.organization_id,
      suggestion: {
        mode: "deterministic_mock",
        text: generated.text,
        confidence: clampConfidence(generated.confidence),
      },
      sourceStatus: "available",
      sources,
      degraded: false,
      fallbackReason: null,
      now,
    });
  }

  async function searchKb(request, embedding) {
    metrics.inc("kb_search_total");
    try {
      return await kbSearch.search({
        organizationId: request.organization_id,
        embedding,
        query: request.query,
        limit: topK,
      });
    } catch (error) {
      metrics.inc("kb_search_failed_total");
      throw error;
    }
  }

  function buildFallback(request, error) {
    return createAssistantSuggestResponse({
      requestId: request.request_id,
      organizationId: request.organization_id,
      suggestion: {
        mode: "fallback",
        text:
          "AI-подсказки временно недоступны. Ответьте клиенту вручную, " +
          "сохраняя контекст диалога и правила организации.",
        confidence: 0,
      },
      sourceStatus: "unavailable",
      sources: [],
      degraded: true,
      fallbackReason: fallbackReasonFor(error),
      now,
    });
  }

  return {
    suggestAssistant,

    async createOnboardingCommand(payload) {
      return commander.createOnboardingCommand(payload);
    },

    getMetrics() {
      return metrics.snapshot();
    },

    getHealth() {
      return {
        llm: describeLlm(selectLlm),
      };
    },
  };
}

/**
 * Best-effort snapshot of the active provider's breaker for `/health`. With a
 * router we cannot know an organization ahead of time, so we probe the default
 * selection; a router without a default simply reports nothing.
 */
function describeLlm(selectLlm) {
  try {
    const llm = selectLlm(undefined);
    return {
      name: llm.name ?? null,
      model: llm.model ?? null,
      breaker: typeof llm.getBreakerState === "function" ? llm.getBreakerState() : null,
    };
  } catch {
    return null;
  }
}

function fallbackReasonFor(error) {
  if (error && error.name === "AbortError") {
    return "timeout";
  }
  if (error && error.reason === "timeout") {
    return "timeout";
  }
  return "unavailable";
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function assertValid(response) {
  const validation = validateAssistantSuggestResponse(response);
  if (!validation.valid) {
    throw new Error(
      `RAG assistant produced an invalid C4 response: ${validation.errors.join("; ")}`,
    );
  }
}
