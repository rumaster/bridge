import { Inject, Injectable, Optional } from "@nestjs/common";

import { FacadeResilience } from "../../common/resilience/resilience";
import type {
  FacadeResilienceOptions,
  ResilienceOutcome,
  ResilienceRejectionReason,
} from "../../common/resilience/resilience";

const DEFAULT_AI_TIMEOUT_MS = 25000;

export type AiDegradationReason = "timeout" | "unavailable";
export const AI_DEGRADATION_OPTIONS = Symbol("AI_DEGRADATION_OPTIONS");

@Injectable()
export class AiDegradationGuard {
  private readonly resilience: FacadeResilience;

  constructor(
    @Optional()
    @Inject(AI_DEGRADATION_OPTIONS)
    options: FacadeResilienceOptions = {},
  ) {
    this.resilience = new FacadeResilience({
      defaultTimeoutMs: DEFAULT_AI_TIMEOUT_MS,
      ...options,
    });
  }

  execute<TResponse>(
    call: (() => Promise<TResponse>) | undefined,
    options: { timeoutMs?: number } = {},
  ): Promise<ResilienceOutcome<TResponse>> {
    return this.resilience.execute(call, options);
  }
}

/**
 * Collapse the resilience rejection taxonomy onto the two degradation reasons
 * the C4 contract exposes: a timeout stays a timeout, every other rejection
 * (missing client, open breaker, saturated bulkhead, upstream error) surfaces
 * as "unavailable" so the conversation keeps working (ТЗ §5.4).
 */
export function toAiDegradationReason(
  reason: ResilienceRejectionReason,
): AiDegradationReason {
  return reason === "timeout" ? "timeout" : "unavailable";
}
