import { Injectable } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";

import { AiDegradationGuard, toAiDegradationReason } from "./ai-degradation.guard";
import type {
  AiAssistantFacadeRequest,
  AiAssistantFacadeResponse,
  AiFacadeDegradationReason,
  AiLlmCompletionFacadeRequest,
  AiLlmCompletionFacadeResponse,
  AiOnboardingFacadeRequest,
  AiOnboardingFacadeResponse,
} from "./ai-integration.types";
import type { AiUpstreamClient } from "./ai-integration.upstream";
import type { FacadeResilienceOptions } from "../../common/resilience/resilience";

export type {
  AiAssistantFacadeRequest,
  AiAssistantFacadeResponse,
  AiFacadeDegradationReason,
  AiLlmCompletionFacadeRequest,
  AiLlmCompletionFacadeResponse,
  AiOnboardingFacadeRequest,
  AiOnboardingFacadeResponse,
} from "./ai-integration.types";

export type FacadeMode = "mock" | "grpc" | "http";
export type FacadeStatusValue = "degraded" | "available";

export interface AiFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C4_VERSION = "1.0.0";

export class FacadeStatusDto {
  @ApiProperty({ example: "ai" })
  name!: string;

  @ApiProperty({ example: "SVC-AI" })
  serviceId!: string;

  @ApiProperty({ enum: ["mock", "grpc", "http"], example: "grpc" })
  mode!: FacadeMode;

  @ApiProperty({ enum: ["degraded", "available"], example: "available" })
  status!: FacadeStatusValue;
}

@Injectable()
export class AiIntegrationFacade {
  private readonly degradationGuard: AiDegradationGuard;

  constructor(
    guardOrOptions: AiDegradationGuard | FacadeResilienceOptions = {},
    private readonly upstream: AiUpstreamClient | null = null,
  ) {
    this.degradationGuard =
      guardOrOptions instanceof AiDegradationGuard
        ? guardOrOptions
        : new AiDegradationGuard(guardOrOptions);
  }

  getStatus(): FacadeStatusDto {
    return {
      mode: this.upstream ? "grpc" : "mock",
      name: "ai",
      serviceId: "SVC-AI",
      status: this.upstream ? "available" : "degraded",
    };
  }

  async suggestAssistant(
    request: AiAssistantFacadeRequest,
    options: AiFacadeCallOptions<AiAssistantFacadeResponse> = {},
  ): Promise<AiAssistantFacadeResponse> {
    const call =
      options.call ?? (this.upstream ? () => this.upstream!.suggestAssistant(request) : undefined);
    const result = await this.degradationGuard.execute(call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createAssistantFallback(request, toAiDegradationReason(result.reason), options.now);
  }

  async createOnboardingCommand(
    request: AiOnboardingFacadeRequest,
    options: AiFacadeCallOptions<AiOnboardingFacadeResponse> = {},
  ): Promise<AiOnboardingFacadeResponse> {
    const call =
      options.call ??
      (this.upstream ? () => this.upstream!.createOnboardingCommand(request) : undefined);
    const result = await this.degradationGuard.execute(call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createOnboardingFallback(
      request,
      toAiDegradationReason(result.reason),
      options.now,
    );
  }

  /**
   * Сырой вызов LLM для узла «LLM» контракта Workflow 2.0 (добавлен 2026-07-15).
   * Идёт через тот же охранник деградации, что и подсказки ассистента: узел схемы
   * не должен вешать запрос, если SVC-AI молчит.
   */
  async completeLlm(
    request: AiLlmCompletionFacadeRequest,
    options: AiFacadeCallOptions<AiLlmCompletionFacadeResponse> = {},
  ): Promise<AiLlmCompletionFacadeResponse> {
    const call =
      options.call ?? (this.upstream ? () => this.upstream!.completeLlm(request) : undefined);
    const result = await this.degradationGuard.execute(call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createLlmCompletionFallback(
      request,
      toAiDegradationReason(result.reason),
      options.now,
    );
  }

  /**
   * Текст фолбэка честно называет себя заглушкой: схема может ветвиться по ответу
   * модели, и заглушка, притворяющаяся ответом, увела бы исполнение не туда.
   * Формальный признак — `degraded: true`.
   */
  private createLlmCompletionFallback(
    request: AiLlmCompletionFacadeRequest,
    reason: AiFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): AiLlmCompletionFacadeResponse {
    return {
      contract: "C4.LlmCompletionResponse",
      version: C4_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      degraded: true,
      fallback_reason: reason,
      completion: {
        text: "LLM is temporarily unavailable: no completion was produced.",
        model: null,
      },
      created_at: now(),
    };
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
