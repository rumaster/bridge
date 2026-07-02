import { Module } from "@nestjs/common";

import { FbpIntegrationFacade } from "./fbp-integration.facade";

@Module({
  exports: [FbpIntegrationFacade],
  providers: [FbpIntegrationFacade],
})
export class FbpIntegrationModule {}
