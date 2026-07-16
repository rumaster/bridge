import { Module } from "@nestjs/common";

import { FbpIntegrationModule } from "../fbp-integration/fbp-integration.module";
import { WorkflowBackendApiAllowlistController } from "./workflow-backend-api-allowlist.controller";
import { WorkflowBackendApiAllowlistService } from "./workflow-backend-api-allowlist.service";
import { WorkflowSubschemaController } from "./workflow-subschema.controller";
import { WorkflowSubschemaService } from "./workflow-subschema.service";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";

@Module({
  // Тест-прогон драфта исполняется настоящим движком, поэтому модулю нужен фасад
  // SVC-FBP (дефект D5). Раньше «тест» ничего не исполнял и зависимости не имел.
  imports: [FbpIntegrationModule],
  controllers: [WorkflowController, WorkflowSubschemaController, WorkflowBackendApiAllowlistController],
  providers: [WorkflowService, WorkflowSubschemaService, WorkflowBackendApiAllowlistService],
})
export class WorkflowModule {}
