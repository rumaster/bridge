import type {
  BroadcastCreateFacadeRequest,
  BroadcastCreateFacadeResponse,
  BroadcastListFacadeRequest,
  BroadcastListFacadeResponse,
  BroadcastStartFacadeRequest,
  BroadcastStartFacadeResponse,
  BroadcastStatsFacadeRequest,
  BroadcastStatsFacadeResponse,
} from "./broadcast-facade.facade";

/**
 * Contract-level client for SVC-BCAST (C8). Production transport is intentionally
 * outside this M4 facade; tests bind deterministic contract mocks here.
 */
export interface BroadcastUpstreamClient {
  listBroadcasts(request: BroadcastListFacadeRequest): Promise<BroadcastListFacadeResponse>;
  createBroadcast(request: BroadcastCreateFacadeRequest): Promise<BroadcastCreateFacadeResponse>;
  startBroadcast(request: BroadcastStartFacadeRequest): Promise<BroadcastStartFacadeResponse>;
  getBroadcastStats(request: BroadcastStatsFacadeRequest): Promise<BroadcastStatsFacadeResponse>;
}

export const BROADCAST_UPSTREAM_CLIENT = "BROADCAST_UPSTREAM_CLIENT";
