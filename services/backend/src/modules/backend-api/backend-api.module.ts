import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { OrganizationModule } from "../organization/organization.module";
import { BackendApiController } from "./backend-api.controller";
import { WorkflowActionApplierService } from "./workflow-action-applier.service";

/**
 * Backend API node (C5) and AI Onboarding apply (C4): the single sanctioned
 * path through which an AI onboarding command or a Workflow node changes data
 * (ТЗ §5.11, §12.6, §13.5). Reuses the owning domain services so all business
 * rules, RLS isolation and audit stay in one place.
 */
@Module({
  controllers: [BackendApiController],
  exports: [WorkflowActionApplierService],
  imports: [AuditModule, ConfigurationModule, OrganizationModule],
  providers: [WorkflowActionApplierService],
})
export class BackendApiModule {}
