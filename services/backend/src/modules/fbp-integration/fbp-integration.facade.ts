import { Injectable, ServiceUnavailableException } from "@nestjs/common";

import { FacadeResilience } from "../../common/resilience/resilience";
import type {
  FacadeResilienceOptions,
  ResilienceRejectionReason,
} from "../../common/resilience/resilience";
import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";
import type { FbpUpstreamClient } from "./fbp-integration.upstream";

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
  status: "started" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "degraded";
  degraded: boolean;
  fallback_reason: FbpFacadeDegradationReason | null;
  state: Record<string, unknown>;
  state_changed_event: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Тест-прогон драфта (дефект D5, решение A5). Экземпляра не создаёт: ни
 * `workflow_version_id` (версии ещё нет), ни `instance_id` — драфт живёт только в
 * редакторе.
 */
export interface FbpTestDraftFacadeRequest {
  request_id: string;
  organization_id: string;
  workflow_id: string;
  actor_user_id: string;
  /** Точка входа схемы 2.0 — узел «Ожидание события». */
  start_node_id: string;
  event_payload?: Record<string, unknown>;
}

/** Один шаг трассы: чем узел был вызван, что получил и что отдал. */
export interface FbpTestDraftTraceEntry {
  nodeId: string;
  type: string;
  /** `flow` — по exec-связи, `data` — вычислен лениво по требованию потребителя. */
  via: "flow" | "data";
  durationMs: number;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  failed: boolean;
  message?: string;
  nodePath: string[];
  depth: number;
}

export interface FbpTestDraftFacadeResponse {
  contract: "C5.TestWorkflowDraftResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  workflow_id: string;
  status: "completed" | "failed";
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  trace: FbpTestDraftTraceEntry[];
  created_at: string;
}

export interface FbpFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C5_VERSION = "1.0.0";
const DEFAULT_FBP_TIMEOUT_MS = 250;

/**
 * Тест-прогон идёт по настоящему движку и потому дольше боевого старта: узел
 * `backend-api` ходит в HTTP, `llm` — в модель. Дефолт фасада в 250 мс здесь
 * означал бы таймаут на любой осмысленной схеме.
 */
const DEFAULT_DRAFT_TEST_TIMEOUT_MS = 30_000;

@Injectable()
export class FbpIntegrationFacade {
  private readonly resilience: FacadeResilience;

  constructor(
    options: FacadeResilienceOptions = {},
    private readonly upstream: FbpUpstreamClient | null = null,
  ) {
    this.resilience = new FacadeResilience({
      defaultTimeoutMs: DEFAULT_FBP_TIMEOUT_MS,
      ...options,
    });
  }

  getStatus(): FacadeStatusDto {
    return {
      mode: this.upstream ? "grpc" : "mock",
      name: "fbp",
      serviceId: "SVC-FBP",
      status: this.upstream ? "available" : "degraded",
    };
  }

  async startWorkflowInstance(
    request: FbpStartWorkflowFacadeRequest,
    options: FbpFacadeCallOptions<FbpStartWorkflowFacadeResponse> = {},
  ): Promise<FbpStartWorkflowFacadeResponse> {
    const call =
      options.call ??
      (this.upstream ? () => this.upstream!.startWorkflowInstance(request) : undefined);
    const result = await this.resilience.execute(call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createStartFallback(request, toDegradationReason(result.reason), options.now);
  }

  /**
   * Тест-прогон драфта (дефект D5, решение A5).
   *
   * ЕДИНСТВЕННЫЙ вызов фасада, который НЕ деградирует. Боевой старт подменяет
   * недоступный движок заглушкой, чтобы сообщения продолжали ходить (§5.4), — но
   * тест-прогон существует ровно затем, чтобы сказать оператору правду о схеме.
   * Заглушка со `status` здесь означала бы «схема работает», хотя её никто не
   * исполнял. Поэтому недоступность движка — это ошибка вызова, а не результат:
   * пусть редактор скажет «движок недоступен», а не «схема прошла».
   */
  async testWorkflowDraft(
    request: FbpTestDraftFacadeRequest,
    options: FbpFacadeCallOptions<FbpTestDraftFacadeResponse> = {},
  ): Promise<FbpTestDraftFacadeResponse> {
    const call =
      options.call ?? (this.upstream ? () => this.upstream!.testWorkflowDraft(request) : undefined);
    const result = await this.resilience.execute(call, {
      timeoutMs: options.timeoutMs ?? DEFAULT_DRAFT_TEST_TIMEOUT_MS,
    });

    if (result.ok) {
      return result.value;
    }

    throw new ServiceUnavailableException({
      code: "WORKFLOW_ENGINE_UNAVAILABLE",
      description: `Workflow engine did not answer the draft test run (${result.reason}).`,
      humanMessage:
        result.reason === "timeout"
          ? "Движок схем не ответил вовремя — тестовый прогон не выполнен."
          : "Движок схем недоступен — тестовый прогон не выполнен.",
    });
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

/**
 * Map the resilience rejection taxonomy onto the two C5 degradation reasons:
 * timeouts stay timeouts, everything else (missing client, open breaker,
 * saturated bulkhead, upstream error) degrades as "unavailable" (ТЗ §11.11).
 */
function toDegradationReason(reason: ResilienceRejectionReason): FbpFacadeDegradationReason {
  return reason === "timeout" ? "timeout" : "unavailable";
}
