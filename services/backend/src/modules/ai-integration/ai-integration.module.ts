import { Module } from "@nestjs/common";

import { AiIntegrationController } from "./ai-integration.controller";
import { AiIntegrationFacade } from "./ai-integration.facade";

@Module({
  controllers: [AiIntegrationController],
  exports: [AiIntegrationFacade],
  providers: [AiIntegrationFacade],
})
export class AiIntegrationModule {}
