import { Module } from "@nestjs/common";

import { createAiGrpcUpstreamClientFromEnv } from "./ai-grpc-upstream.client";
import { AiDegradationGuard } from "./ai-degradation.guard";
import { AiIntegrationController } from "./ai-integration.controller";
import { AiIntegrationFacade } from "./ai-integration.facade";
import { AI_UPSTREAM_CLIENT } from "./ai-integration.upstream";
import type { AiUpstreamClient } from "./ai-integration.upstream";

@Module({
  controllers: [AiIntegrationController],
  exports: [AiIntegrationFacade],
  providers: [
    AiDegradationGuard,
    {
      provide: AI_UPSTREAM_CLIENT,
      useFactory: () => createAiGrpcUpstreamClientFromEnv(),
    },
    {
      // The facade remains manually constructible with plain options, so Nest
      // receives the injectable guard through a factory.
      provide: AiIntegrationFacade,
      inject: [AiDegradationGuard, AI_UPSTREAM_CLIENT],
      useFactory: (guard: AiDegradationGuard, upstream: AiUpstreamClient | null) =>
        new AiIntegrationFacade(guard, upstream),
    },
  ],
})
export class AiIntegrationModule {}
