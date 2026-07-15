import { Module } from "@nestjs/common";

import { WorkflowBackendApiAllowlistController } from "./workflow-backend-api-allowlist.controller";
import { WorkflowBackendApiAllowlistService } from "./workflow-backend-api-allowlist.service";
import { WorkflowSubschemaController } from "./workflow-subschema.controller";
import { WorkflowSubschemaService } from "./workflow-subschema.service";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";

@Module({
  controllers: [WorkflowController, WorkflowSubschemaController, WorkflowBackendApiAllowlistController],
  providers: [WorkflowService, WorkflowSubschemaService, WorkflowBackendApiAllowlistService],
})
export class WorkflowModule {}
