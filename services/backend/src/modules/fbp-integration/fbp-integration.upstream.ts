import type {
  FbpStartWorkflowFacadeRequest,
  FbpStartWorkflowFacadeResponse,
} from "./fbp-integration.facade";

/**
 * Contract-level client for the externalised SVC-FBP engine (C5). The backend
 * only starts Workflow instances through a thin facade guarded by timeout +
 * circuit breaker + bulkhead (ТЗ §11.2); this is the pluggable transport the
 * facade calls. Stage 2 wires this token to the internal C5 gRPC channel when
 * `FBP_GRPC_TARGET` is configured; otherwise the token resolves to `null` and
 * every facade call degrades in a controlled way (ТЗ §11.11).
 */
export interface FbpUpstreamClient {
  startWorkflowInstance(
    request: FbpStartWorkflowFacadeRequest,
  ): Promise<FbpStartWorkflowFacadeResponse>;
}

export const FBP_UPSTREAM_CLIENT = "FBP_UPSTREAM_CLIENT";
