import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";

@Module({
  controllers: [OrganizationController],
  imports: [AuditModule],
  providers: [OrganizationService],
})
export class OrganizationModule {}
