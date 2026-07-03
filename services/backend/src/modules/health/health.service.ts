import { Injectable } from "@nestjs/common";

import { AiIntegrationFacade } from "../ai-integration/ai-integration.facade";
import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";
import { BroadcastFacade } from "../broadcast-facade/broadcast-facade.facade";
import { FbpIntegrationFacade } from "../fbp-integration/fbp-integration.facade";
import { IntegrationGatewayFacade } from "../integration-gateway/integration-gateway.facade";
import { NotificationFacade } from "../notification-facade/notification-facade.facade";
import type { HealthResponseDto } from "./health.dto";

@Injectable()
export class HealthService {
  constructor(
    private readonly aiFacade: AiIntegrationFacade,
    private readonly fbpFacade: FbpIntegrationFacade,
    private readonly broadcastFacade: BroadcastFacade,
    private readonly integrationGatewayFacade: IntegrationGatewayFacade,
    private readonly notificationFacade: NotificationFacade,
  ) {}

  getHealth(): HealthResponseDto {
    return {
      checks: {
        facades: this.getFacadeStatuses(),
        http: "ok",
      },
      service: "backend",
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "0.0.0",
    };
  }

  getFacadeStatuses(): FacadeStatusDto[] {
    return [
      this.aiFacade.getStatus(),
      this.fbpFacade.getStatus(),
      this.broadcastFacade.getStatus(),
      this.integrationGatewayFacade.getStatus(),
      this.notificationFacade.getStatus(),
    ];
  }
}
