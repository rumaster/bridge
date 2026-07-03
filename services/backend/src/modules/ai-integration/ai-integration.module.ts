import { Module } from "@nestjs/common";

import { AiIntegrationController } from "./ai-integration.controller";
import { AiIntegrationFacade } from "./ai-integration.facade";

@Module({
  controllers: [AiIntegrationController],
  exports: [AiIntegrationFacade],
  providers: [
    {
      // The facade constructor takes a plain resilience-options object (not an
      // injectable), so it is built via a factory rather than class autowiring.
      provide: AiIntegrationFacade,
      useFactory: () => new AiIntegrationFacade(),
    },
  ],
})
export class AiIntegrationModule {}
