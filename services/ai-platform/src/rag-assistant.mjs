import {
  createAssistantSuggestResponse,
  validateAssistantSuggestResponse,
} from "../../../packages/contracts/src/c4.mjs";

import { assertAssistantSuggestRequest } from "./c4-dto.mjs";
import { createDeterministicMockLlm } from "./llm.mjs";
import { createDeterministicAiMock } from "./deterministic-ai.mjs";
import { buildPrompt, buildSources, rankChunks } from "./rag-pipeline.mjs";

const DEFAULT_TOP_K = 5;

/**
 * RAG-backed C4 AI Assistant (CP-3).
 *
 * Flow (ТЗ §12.3, §12.7): embed the query through the swappable LLM abstraction →
 * ask Backend to search the Knowledge Base (C3.kb) under tenant isolation → rank
 * the returned chunks → generate an answer with source citations. Any failure in
 * that chain degrades to a safe fallback so messaging stays usable (ТЗ §5.4): the
 * response is still a valid C4 payload, just `degraded: true` with `mode:
 * "fallback"` and `source_status: "unavailable"`.
 *
 * AI Onboarding / structured commands remain the M0 deterministic mock (M3 scope)
 * and are delegated unchanged.
 */
export function createRagAssistant({
  llm = createDeterministicMockLlm(),
  kbSearch,
  onboarding = createDeterministicAiMock({ now: () => new Date().toISOString() }),
  topK = DEFAULT_TOP_K,
  now = () => new Date().toISOString(),
} = {}) {
  if (!kbSearch || typeof kbSearch.search !== "function") {
    throw new TypeError("createRagAssistant requires a kbSearch with a search() method");
  }

  const metrics = {
    assistant_suggest_total: 0,
    assistant_suggest_degraded_total: 0,
    onboarding_command_total: 0,
  };

  async function suggestAssistant(payload) {
    const request = assertAssistantSuggestRequest(payload);
    metrics.assistant_suggest_total += 1;

    try {
      const response = await runPipeline(request);
      assertValid(response);
      return response;
    } catch (error) {
      metrics.assistant_suggest_degraded_total += 1;
      const response = buildFallback(request, error);
      assertValid(response);
      return response;
    }
  }

  async function runPipeline(request) {
    const embedding = await llm.embed(request.query);
    const { results } = await kbSearch.search({
      organizationId: request.organization_id,
      embedding,
      query: request.query,
      limit: topK,
    });

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

    const generated = await llm.generate({
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

    createOnboardingCommand(payload) {
      const command = onboarding.createOnboardingCommand(payload);
      metrics.onboarding_command_total += 1;
      return command;
    },

    getMetrics() {
      return { ...metrics };
    },
  };
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
