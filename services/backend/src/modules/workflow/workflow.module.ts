import { Module } from "@nestjs/common";

import { WorkflowSubschemaController } from "./workflow-subschema.controller";
import { WorkflowSubschemaService } from "./workflow-subschema.service";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";

@Module({
  controllers: [WorkflowController, WorkflowSubschemaController],
  providers: [WorkflowService, WorkflowSubschemaService],
})
export class WorkflowModule {}
