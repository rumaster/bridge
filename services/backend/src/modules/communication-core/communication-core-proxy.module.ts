import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConversationController, MessageController } from "./communication-core.controller";
import {
  AdapterFailureCoordinator,
  CommunicationCoreLoadProbeService,
} from "./communication-core-m5.service";
import { CommunicationCoreProxyService } from "./communication-core-proxy.service";
import { EdgeIntakeCoordinatorService } from "./edge-intake.service";
import { InternalMessagingController } from "./internal-messaging.controller";
import { InternalMessagingService } from "./internal-messaging.service";

@Module({
  controllers: [ConversationController, MessageController, InternalMessagingController],
  exports: [
    AdapterFailureCoordinator,
    CommunicationCoreLoadProbeService,
    CommunicationCoreProxyService,
    EdgeIntakeCoordinatorService,
    InternalMessagingService,
  ],
  imports: [AuditModule],
  providers: [
    AdapterFailureCoordinator,
    CommunicationCoreLoadProbeService,
    CommunicationCoreProxyService,
    EdgeIntakeCoordinatorService,
    InternalMessagingService,
  ],
})
export class CommunicationCoreProxyModule {}
