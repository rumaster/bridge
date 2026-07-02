import { Injectable } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

@Injectable()
export class NotificationFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "notification",
      serviceId: "SVC-NOTIF",
      status: "degraded",
    };
  }
}
