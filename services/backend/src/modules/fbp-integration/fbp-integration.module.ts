import { Module } from "@nestjs/common";

import { FbpIntegrationController } from "./fbp-integration.controller";
import { FbpIntegrationFacade } from "./fbp-integration.facade";

@Module({
  controllers: [FbpIntegrationController],
  exports: [FbpIntegrationFacade],
  providers: [
    {
      // The facade constructor takes a plain resilience-options object (not an
      // injectable), so it is built via a factory rather than class autowiring.
      provide: FbpIntegrationFacade,
      useFactory: () => new FbpIntegrationFacade(),
    },
  ],
})
export class FbpIntegrationModule {}
