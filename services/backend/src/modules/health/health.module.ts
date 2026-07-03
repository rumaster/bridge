import { Module } from "@nestjs/common";

import { AiIntegrationModule } from "../ai-integration/ai-integration.module";
import { BroadcastFacadeModule } from "../broadcast-facade/broadcast-facade.module";
import { FbpIntegrationModule } from "../fbp-integration/fbp-integration.module";
import { IntegrationGatewayModule } from "../integration-gateway/integration-gateway.module";
import { NotificationFacadeModule } from "../notification-facade/notification-facade.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { MetricsService } from "./metrics.service";

@Module({
  controllers: [HealthController],
  exports: [HealthService, MetricsService],
  imports: [
    AiIntegrationModule,
    FbpIntegrationModule,
    BroadcastFacadeModule,
    IntegrationGatewayModule,
    NotificationFacadeModule,
  ],
  providers: [HealthService, MetricsService],
})
export class HealthModule {}
