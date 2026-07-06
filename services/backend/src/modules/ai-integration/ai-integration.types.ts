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
    mode: "deterministic_mock" | "fallback";
    text: string;
    confidence: number;
  };
  source_status: "available" | "not_available_m0" | "unavailable";
  sources: unknown[];
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
