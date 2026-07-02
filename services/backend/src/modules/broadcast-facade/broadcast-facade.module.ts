import { Module } from "@nestjs/common";

import { BroadcastFacade } from "./broadcast-facade.facade";

@Module({
  exports: [BroadcastFacade],
  providers: [BroadcastFacade],
})
export class BroadcastFacadeModule {}
