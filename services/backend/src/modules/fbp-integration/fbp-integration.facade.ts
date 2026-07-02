import { Injectable } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export type FbpFacadeDegradationReason = "timeout" | "unavailable";

export interface FbpStartWorkflowFacadeRequest {
  request_id: string;
  organization_id: string;
  workflow_id: string;
  workflow_version_id: string;
  actor_user_id: string;
  input?: Record<string, unknown>;
}

export interface FbpStartWorkflowFacadeResponse {
  contract: "C5.StartWorkflowInstanceResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  workflow_id: string;
  workflow_version_id: string;
  instance_id: string;
  status: "started" | "completed" | "failed" | "degraded";
  degraded: boolean;
  fallback_reason: FbpFacadeDegradationReason | null;
  state: Record<string, unknown>;
  state_changed_event: Record<string, unknown> | null;
  created_at: string;
}

export interface FbpFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C5_VERSION = "1.0.0";
const DEFAULT_FBP_TIMEOUT_MS = 250;

@Injectable()
export class FbpIntegrationFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "fbp",
      serviceId: "SVC-FBP",
      status: "degraded",
    };
  }

  async startWorkflowInstance(
    request: FbpStartWorkflowFacadeRequest,
    options: FbpFacadeCallOptions<FbpStartWorkflowFacadeResponse> = {},
  ): Promise<FbpStartWorkflowFacadeResponse> {
    const result = await this.callFbp(options);
    if (result.ok) {
      return result.value;
    }

    return this.createStartFallback(request, result.reason, options.now);
  }

  private async callFbp<TResponse>(
    options: FbpFacadeCallOptions<TResponse>,
  ): Promise<
    | { ok: true; value: TResponse }
    | { ok: false; reason: FbpFacadeDegradationReason }
  > {
    if (!options.call) {
      return {
        ok: false,
        reason: "unavailable",
      };
    }

    try {
      const value = await withTimeout(
        options.call(),
        options.timeoutMs ?? DEFAULT_FBP_TIMEOUT_MS,
      );
      return {
        ok: true,
        value,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof FbpFacadeTimeoutError ? "timeout" : "unavailable",
      };
    }
  }

  private createStartFallback(
    request: FbpStartWorkflowFacadeRequest,
    reason: FbpFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): FbpStartWorkflowFacadeResponse {
    return {
      contract: "C5.StartWorkflowInstanceResponse",
      version: C5_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      workflow_id: request.workflow_id,
      workflow_version_id: request.workflow_version_id,
      instance_id: `${request.request_id}:fbp-${reason}`,
      status: "degraded",
      degraded: true,
      fallback_reason: reason,
      state: {
        status: "degraded",
        reason: `fbp_${reason}`,
        input: request.input ?? {},
        actor_user_id: request.actor_user_id,
      },
      state_changed_event: null,
      created_at: now(),
    };
  }
}

async function withTimeout<TValue>(
  promise: Promise<TValue>,
  timeoutMs: number,
): Promise<TValue> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new FbpFacadeTimeoutError());
    }, Math.max(1, timeoutMs));
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class FbpFacadeTimeoutError extends Error {
  constructor() {
    super("FBP facade call timed out.");
    this.name = "FbpFacadeTimeoutError";
  }
}
