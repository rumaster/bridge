import { Module } from "@nestjs/common";

import { BroadcastFacadeController } from "./broadcast-facade.controller";
import { BroadcastFacade } from "./broadcast-facade.facade";
import { createBroadcastGrpcUpstreamClientFromEnv } from "./broadcast-grpc-upstream.client";
import { BROADCAST_UPSTREAM_CLIENT } from "./broadcast-facade.upstream";
import type { BroadcastUpstreamClient } from "./broadcast-facade.upstream";

@Module({
  controllers: [BroadcastFacadeController],
  exports: [BroadcastFacade],
  providers: [
    {
      provide: BroadcastFacade,
      inject: [BROADCAST_UPSTREAM_CLIENT],
      useFactory: (upstream: BroadcastUpstreamClient | null) =>
        new BroadcastFacade({}, upstream),
    },
    {
      provide: BROADCAST_UPSTREAM_CLIENT,
      useFactory: () => createBroadcastGrpcUpstreamClientFromEnv(),
    },
  ],
})
export class BroadcastFacadeModule {}
