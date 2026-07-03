import type {
  FbpStartWorkflowFacadeRequest,
  FbpStartWorkflowFacadeResponse,
} from "./fbp-integration.facade";

/**
 * Contract-level client for the externalised SVC-FBP engine (C5). The backend
 * only starts Workflow instances through a thin facade guarded by timeout +
 * circuit breaker + bulkhead (ТЗ §11.2); this is the pluggable transport the
 * facade calls. In M0/M3 no live SVC-FBP transport is wired into the backend
 * process, so the token resolves to `null` and every facade call degrades in a
 * controlled way (ТЗ §11.11). Integration tests bind a deterministic contract
 * mock to exercise the success path.
 */
export interface FbpUpstreamClient {
  startWorkflowInstance(
    request: FbpStartWorkflowFacadeRequest,
  ): Promise<FbpStartWorkflowFacadeResponse>;
}

export const FBP_UPSTREAM_CLIENT = "FBP_UPSTREAM_CLIENT";
