import { Injectable } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export type BroadcastFacadeDegradationReason = "timeout" | "unavailable";
export type BroadcastStatus = "draft" | "scheduled" | "running" | "done" | "failed";

export interface BroadcastCampaignFacade {
  id: string;
  organization_id: string;
  name: string;
  status: BroadcastStatus;
  template: Record<string, unknown>;
  filter: Record<string, unknown>;
  schedule: Record<string, unknown>;
  rate_limit: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BroadcastSummaryFacade {
  id: string;
  organization_id?: string;
  status: BroadcastStatus;
  updated_at?: string;
}

export interface BroadcastCreateFacadeRequest {
  request_id: string;
  organization_id: string;
  created_by: string;
  name: string;
  template?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  rate_limit?: Record<string, unknown>;
}

export interface BroadcastStartFacadeRequest {
  request_id: string;
  organization_id: string;
  broadcast_id: string;
  started_by: string;
  mode?: "immediate" | "scheduled";
  scheduled_for?: string;
}

export interface BroadcastStatsFacadeRequest {
  request_id: string;
  organization_id: string;
  broadcast_id: string;
}

export interface BroadcastCreateFacadeResponse {
  contract: "C8.CreateBroadcastResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  broadcast: BroadcastCampaignFacade;
  degraded?: boolean;
  fallback_reason?: BroadcastFacadeDegradationReason | null;
}

export interface BroadcastStartFacadeResponse {
  contract: "C8.StartBroadcastResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  broadcast: BroadcastSummaryFacade;
  degraded: boolean;
  fallback_reason: BroadcastFacadeDegradationReason | null;
  core_delivery_draft: Record<string, unknown> | null;
  state_changed_event?: Record<string, unknown> | null;
  created_at: string;
}

export interface BroadcastStatsFacadeResponse {
  contract: "C8.BroadcastStatsResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  broadcast_id: string;
  status: BroadcastStatus;
  stats: {
    prepared: number;
    sent: number;
    delivered: number;
    failed: number;
    updated_at: string;
  };
  degraded: boolean;
  fallback_reason: BroadcastFacadeDegradationReason | null;
}

export interface BroadcastFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C8_VERSION = "1.0.0";
const DEFAULT_BROADCAST_TIMEOUT_MS = 250;

@Injectable()
export class BroadcastFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "broadcast",
      serviceId: "SVC-BCAST",
      status: "degraded",
    };
  }

  async createBroadcast(
    request: BroadcastCreateFacadeRequest,
    options: BroadcastFacadeCallOptions<BroadcastCreateFacadeResponse> = {},
  ): Promise<BroadcastCreateFacadeResponse> {
    const result = await this.callBroadcast(options);
    if (result.ok) {
      return result.value;
    }

    return this.createBroadcastFallback(request, result.reason, options.now);
  }

  async startBroadcast(
    request: BroadcastStartFacadeRequest,
    options: BroadcastFacadeCallOptions<BroadcastStartFacadeResponse> = {},
  ): Promise<BroadcastStartFacadeResponse> {
    const result = await this.callBroadcast(options);
    if (result.ok) {
      return result.value;
    }

    return this.createStartFallback(request, result.reason, options.now);
  }

  async getBroadcastStats(
    request: BroadcastStatsFacadeRequest,
    options: BroadcastFacadeCallOptions<BroadcastStatsFacadeResponse> = {},
  ): Promise<BroadcastStatsFacadeResponse> {
    const result = await this.callBroadcast(options);
    if (result.ok) {
      return result.value;
    }

    return this.createStatsFallback(request, result.reason, options.now);
  }

  private async callBroadcast<TResponse>(
    options: BroadcastFacadeCallOptions<TResponse>,
  ): Promise<
    | { ok: true; value: TResponse }
    | { ok: false; reason: BroadcastFacadeDegradationReason }
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
        options.timeoutMs ?? DEFAULT_BROADCAST_TIMEOUT_MS,
      );
      return {
        ok: true,
        value,
      };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof BroadcastFacadeTimeoutError ? "timeout" : "unavailable",
      };
    }
  }

  private createBroadcastFallback(
    request: BroadcastCreateFacadeRequest,
    reason: BroadcastFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): BroadcastCreateFacadeResponse {
    const createdAt = now();

    return {
      contract: "C8.CreateBroadcastResponse",
      version: C8_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      degraded: true,
      fallback_reason: reason,
      broadcast: {
        id: `${request.request_id}:broadcast-${reason}`,
        organization_id: request.organization_id,
        name: request.name,
        status: "failed",
        template: request.template ?? {},
        filter: request.filter ?? {},
        schedule: request.schedule ?? {},
        rate_limit: request.rate_limit ?? {},
        created_by: request.created_by,
        created_at: createdAt,
        updated_at: createdAt,
      },
    };
  }

  private createStartFallback(
    request: BroadcastStartFacadeRequest,
    reason: BroadcastFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): BroadcastStartFacadeResponse {
    return {
      contract: "C8.StartBroadcastResponse",
      version: C8_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      broadcast: {
        id: request.broadcast_id,
        organization_id: request.organization_id,
        status: "failed",
        updated_at: now(),
      },
      degraded: true,
      fallback_reason: reason,
      core_delivery_draft: null,
      state_changed_event: null,
      created_at: now(),
    };
  }

  private createStatsFallback(
    request: BroadcastStatsFacadeRequest,
    reason: BroadcastFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): BroadcastStatsFacadeResponse {
    return {
      contract: "C8.BroadcastStatsResponse",
      version: C8_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      broadcast_id: request.broadcast_id,
      status: "failed",
      stats: {
        prepared: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        updated_at: now(),
      },
      degraded: true,
      fallback_reason: reason,
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
      reject(new BroadcastFacadeTimeoutError());
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

class BroadcastFacadeTimeoutError extends Error {
  constructor() {
    super("Broadcast facade call timed out.");
    this.name = "BroadcastFacadeTimeoutError";
  }
}
