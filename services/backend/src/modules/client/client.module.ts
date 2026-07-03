import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CommunicationCoreProxyModule } from "../communication-core/communication-core-proxy.module";
import { ClientController, ClientMergeController } from "./client.controller";
import { ClientService } from "./client.service";

@Module({
  controllers: [ClientController, ClientMergeController],
  imports: [AuditModule, CommunicationCoreProxyModule],
  providers: [ClientService],
})
export class ClientModule {}
