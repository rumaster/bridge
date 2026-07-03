import type {
  AiAssistantFacadeRequest,
  AiAssistantFacadeResponse,
  AiOnboardingFacadeRequest,
  AiOnboardingFacadeResponse,
} from "./ai-integration.facade";

/**
 * Contract-level client for the externalised SVC-AI service (C4). The backend
 * only ever talks to AI through a thin facade guarded by timeout + circuit
 * breaker + bulkhead (ТЗ §11.2); this is the pluggable transport the facade
 * calls. In M0/M3 no live SVC-AI transport is wired into the backend process,
 * so the token resolves to `null` and every facade call degrades in a
 * controlled way (ТЗ §5.4). Integration tests bind a deterministic contract
 * mock to exercise the success path (мастер §8.4).
 */
export interface AiUpstreamClient {
  suggestAssistant(request: AiAssistantFacadeRequest): Promise<AiAssistantFacadeResponse>;
  createOnboardingCommand(
    request: AiOnboardingFacadeRequest,
  ): Promise<AiOnboardingFacadeResponse>;
}

export const AI_UPSTREAM_CLIENT = "AI_UPSTREAM_CLIENT";
