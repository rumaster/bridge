import { Injectable } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

@Injectable()
export class BroadcastFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "broadcast",
      serviceId: "SVC-BCAST",
      status: "degraded",
    };
  }
}
