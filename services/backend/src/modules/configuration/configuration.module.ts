import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigurationController } from "./configuration.controller";
import { ConfigurationService } from "./configuration.service";

@Module({
  controllers: [ConfigurationController],
  imports: [AuditModule],
  providers: [ConfigurationService],
})
export class ConfigurationModule {}
