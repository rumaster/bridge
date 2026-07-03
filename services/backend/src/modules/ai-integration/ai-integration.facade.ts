import { Injectable } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";

import { FacadeResilience } from "../../common/resilience/resilience";
import type {
  FacadeResilienceOptions,
  ResilienceRejectionReason,
} from "../../common/resilience/resilience";

export type FacadeMode = "mock";
export type FacadeStatusValue = "degraded";
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

export interface AiFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C4_VERSION = "1.0.0";
const DEFAULT_AI_TIMEOUT_MS = 250;

export class FacadeStatusDto {
  @ApiProperty({ example: "ai" })
  name!: string;

  @ApiProperty({ example: "SVC-AI" })
  serviceId!: string;

  @ApiProperty({ enum: ["mock"], example: "mock" })
  mode!: FacadeMode;

  @ApiProperty({ enum: ["degraded"], example: "degraded" })
  status!: FacadeStatusValue;
}

@Injectable()
export class AiIntegrationFacade {
  private readonly resilience: FacadeResilience;

  constructor(options: FacadeResilienceOptions = {}) {
    this.resilience = new FacadeResilience({
      defaultTimeoutMs: DEFAULT_AI_TIMEOUT_MS,
      ...options,
    });
  }

  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "ai",
      serviceId: "SVC-AI",
      status: "degraded",
    };
  }

  async suggestAssistant(
    request: AiAssistantFacadeRequest,
    options: AiFacadeCallOptions<AiAssistantFacadeResponse> = {},
  ): Promise<AiAssistantFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createAssistantFallback(request, toDegradationReason(result.reason), options.now);
  }

  async createOnboardingCommand(
    request: AiOnboardingFacadeRequest,
    options: AiFacadeCallOptions<AiOnboardingFacadeResponse> = {},
  ): Promise<AiOnboardingFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createOnboardingFallback(request, toDegradationReason(result.reason), options.now);
  }

  private createAssistantFallback(
    request: AiAssistantFacadeRequest,
    reason: AiFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): AiAssistantFacadeResponse {
    return {
      contract: "C4.AssistantSuggestResponse",
      version: C4_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      degraded: true,
      fallback_reason: reason,
      suggestion: {
        mode: "fallback",
        text: "AI suggestion is temporarily unavailable. Continue the conversation without AI assistance.",
        confidence: 0,
      },
      source_status: "unavailable",
      sources: [],
      created_at: now(),
    };
  }

  private createOnboardingFallback(
    request: AiOnboardingFacadeRequest,
    reason: AiFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): AiOnboardingFacadeResponse {
    return {
      contract: "C4.OnboardingCommandResponse",
      version: C4_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      degraded: true,
      fallback_reason: reason,
      command: {
        contract: "C4.AiOnboardingCommand",
        version: C4_VERSION,
        command_id: `${request.request_id}:fallback`,
        organization_id: request.organization_id,
        action: "noop",
        params: {
          reason: `ai_${reason}`,
        },
        safety: {
          apply_mode: "backend_validation_required",
          requires_confirmation: false,
          notes: [
            "AI Platform did not return a command; Backend must keep existing configuration unchanged.",
          ],
        },
        source: {
          prompt: request.prompt,
          generated_by: "fallback",
        },
        created_at: now(),
      },
    };
  }
}

/**
 * Collapse the resilience rejection taxonomy onto the two degradation reasons
 * the C4 contract exposes: a timeout stays a timeout, every other rejection
 * (missing client, open breaker, saturated bulkhead, upstream error) surfaces
 * as "unavailable" so the conversation keeps working (ТЗ §5.4).
 */
function toDegradationReason(reason: ResilienceRejectionReason): AiFacadeDegradationReason {
  return reason === "timeout" ? "timeout" : "unavailable";
}
