import { Module } from "@nestjs/common";

import { FbpIntegrationController } from "./fbp-integration.controller";
import { FbpIntegrationFacade } from "./fbp-integration.facade";

@Module({
  controllers: [FbpIntegrationController],
  exports: [FbpIntegrationFacade],
  providers: [FbpIntegrationFacade],
})
export class FbpIntegrationModule {}
