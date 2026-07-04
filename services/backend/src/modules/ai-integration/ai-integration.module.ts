import { Module } from "@nestjs/common";

import { AiDegradationGuard } from "./ai-degradation.guard";
import { AiIntegrationController } from "./ai-integration.controller";
import { AiIntegrationFacade } from "./ai-integration.facade";

@Module({
  controllers: [AiIntegrationController],
  exports: [AiIntegrationFacade],
  providers: [
    AiDegradationGuard,
    {
      // The facade remains manually constructible with plain options, so Nest
      // receives the injectable guard through a factory.
      provide: AiIntegrationFacade,
      inject: [AiDegradationGuard],
      useFactory: (guard: AiDegradationGuard) => new AiIntegrationFacade(guard),
    },
  ],
})
export class AiIntegrationModule {}
