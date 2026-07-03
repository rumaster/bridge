import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConversationController, MessageController } from "./communication-core.controller";
import { CommunicationCoreProxyService } from "./communication-core-proxy.service";

@Module({
  controllers: [ConversationController, MessageController],
  exports: [CommunicationCoreProxyService],
  imports: [AuditModule],
  providers: [CommunicationCoreProxyService],
})
export class CommunicationCoreProxyModule {}
