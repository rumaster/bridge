import type {
  AiAssistantFacadeRequest,
  AiAssistantFacadeResponse,
  AiLlmCompletionFacadeRequest,
  AiLlmCompletionFacadeResponse,
  AiOnboardingFacadeRequest,
  AiOnboardingFacadeResponse,
} from "./ai-integration.types";

/**
 * Contract-level client for the externalised SVC-AI service (C4). The backend
 * only ever talks to AI through a thin facade guarded by timeout + circuit
 * breaker + bulkhead (ТЗ §11.2); this is the pluggable transport the facade
 * calls. Stage 1 wires this token to the internal C4 gRPC channel when
 * `AI_GRPC_TARGET` is configured; otherwise the token resolves to `null` and
 * facade calls degrade in a controlled way (ТЗ §5.4).
 */
export interface AiUpstreamClient {
  suggestAssistant(request: AiAssistantFacadeRequest): Promise<AiAssistantFacadeResponse>;
  createOnboardingCommand(
    request: AiOnboardingFacadeRequest,
  ): Promise<AiOnboardingFacadeResponse>;
  /** Сырой вызов LLM для узла «LLM» контракта Workflow 2.0 (добавлен 2026-07-15). */
  completeLlm(request: AiLlmCompletionFacadeRequest): Promise<AiLlmCompletionFacadeResponse>;
}

export const AI_UPSTREAM_CLIENT = "AI_UPSTREAM_CLIENT";
