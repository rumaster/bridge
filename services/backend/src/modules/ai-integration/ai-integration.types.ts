export type AiFacadeDegradationReason = "timeout" | "unavailable";

export interface AiAssistantFacadeRequest {
  request_id: string;
  organization_id: string;
  query: string;
}

export interface AiAssistantFacadeResponse {
  contract: "C4.AssistantSuggestResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  degraded: boolean;
  fallback_reason: AiFacadeDegradationReason | null;
  suggestion: {
    mode: "generated" | "fallback";
    text: string;
    confidence: number;
  };
  source_status: "available" | "not_available_m0" | "unavailable";
  sources: unknown[];
  created_at: string;
}

/**
 * Сырой вызов LLM для узла «LLM» контракта Workflow 2.0 (добавлен 2026-07-15).
 * Ни `query`, ни базы знаний: промпт собирает схема, подставляя значения входных
 * портов, — движок не должен зависеть от того, как AI строит промпт.
 */
export interface AiLlmCompletionFacadeRequest {
  request_id: string;
  organization_id: string;
  prompt: string;
  params: Record<string, unknown>;
}

export interface AiLlmCompletionFacadeResponse {
  contract: "C4.LlmCompletionResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  degraded: boolean;
  /**
   * Шире, чем у ассистента: SVC-AI различает открытый предохранитель и пустой
   * ответ модели. Backend свои фолбэки размечает только `timeout`/`unavailable`.
   */
  fallback_reason: AiFacadeDegradationReason | "circuit_open" | "invalid_response" | null;
  completion: {
    text: string;
    model: string | null;
  };
  created_at: string;
}

export interface AiOnboardingFacadeRequest {
  request_id: string;
  organization_id: string;
  prompt: string;
}

export interface AiOnboardingFacadeResponse {
  contract: "C4.OnboardingCommandResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  degraded: boolean;
  fallback_reason: AiFacadeDegradationReason | null;
  command: {
    contract: "C4.AiOnboardingCommand";
    version: "1.0.0";
    command_id: string;
    organization_id: string;
    action: "noop";
    params: Record<string, unknown>;
    safety: {
      apply_mode: "backend_validation_required";
      requires_confirmation: false;
      notes: string[];
    };
    source: {
      prompt: string;
      generated_by: "fallback";
    };
    created_at: string;
  };
}
