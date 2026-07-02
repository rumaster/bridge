import { Injectable } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

@Injectable()
export class FbpIntegrationFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "fbp",
      serviceId: "SVC-FBP",
      status: "degraded",
    };
  }
}
