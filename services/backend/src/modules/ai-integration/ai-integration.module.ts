import { Module } from "@nestjs/common";

import { AiIntegrationFacade } from "./ai-integration.facade";

@Module({
  exports: [AiIntegrationFacade],
  providers: [AiIntegrationFacade],
})
export class AiIntegrationModule {}
