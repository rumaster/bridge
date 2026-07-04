import { Module } from "@nestjs/common";

import { BroadcastFacadeController } from "./broadcast-facade.controller";
import { BroadcastFacade } from "./broadcast-facade.facade";
import { BROADCAST_UPSTREAM_CLIENT } from "./broadcast-facade.upstream";

@Module({
  controllers: [BroadcastFacadeController],
  exports: [BroadcastFacade],
  providers: [
    {
      provide: BroadcastFacade,
      useFactory: () => new BroadcastFacade(),
    },
    {
      provide: BROADCAST_UPSTREAM_CLIENT,
      useValue: null,
    },
  ],
})
export class BroadcastFacadeModule {}
