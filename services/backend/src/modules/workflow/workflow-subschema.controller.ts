import { Controller, Get, Headers, UseGuards, Version } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import { WorkflowSubschemaResponseDto } from "./workflow.dto";
import { WorkflowSubschemaService } from "./workflow-subschema.service";

@ApiTags("workflow-subschemas")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("platform_operator")
@Controller("workflow-subschemas")
export class WorkflowSubschemaController {
  constructor(private readonly subschemas: WorkflowSubschemaService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List reusable Workflow subschemas" })
  @ApiOkResponse({ type: WorkflowSubschemaResponseDto, isArray: true })
  listSubschemas(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
  ): Promise<WorkflowSubschemaResponseDto[]> {
    return this.subschemas.listSubschemas(getRequiredOrganizationId(organizationIdHeader));
  }
}
