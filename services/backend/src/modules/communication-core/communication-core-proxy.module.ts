import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConversationController, MessageController } from "./communication-core.controller";
import { CommunicationCoreProxyService } from "./communication-core-proxy.service";
import { InternalMessagingController } from "./internal-messaging.controller";
import { InternalMessagingService } from "./internal-messaging.service";

@Module({
  controllers: [ConversationController, MessageController, InternalMessagingController],
  exports: [CommunicationCoreProxyService, InternalMessagingService],
  imports: [AuditModule],
  providers: [CommunicationCoreProxyService, InternalMessagingService],
})
export class CommunicationCoreProxyModule {}
