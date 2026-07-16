import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import {
  CreateWorkflowSubschemaDto,
  UpdateWorkflowSubschemaDto,
  WorkflowSubschemaResponseDto,
} from "./workflow.dto";
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

  /**
   * Дефект D3: редактор звал этот маршрут с самого начала, но контроллер имел
   * только GET — в проде 404, работало лишь против MSW-моков.
   */
  @Post()
  @Version("1")
  @ApiOperation({ summary: "Create a reusable Workflow subschema" })
  @ApiCreatedResponse({ type: WorkflowSubschemaResponseDto })
  createSubschema(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Body() body: CreateWorkflowSubschemaDto,
  ): Promise<WorkflowSubschemaResponseDto> {
    return this.subschemas.createSubschema(getRequiredOrganizationId(organizationIdHeader), body);
  }

  @Patch(":subschemaId")
  @Version("1")
  @ApiOperation({ summary: "Update a reusable Workflow subschema" })
  @ApiOkResponse({ type: WorkflowSubschemaResponseDto })
  updateSubschema(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("subschemaId", new ParseUUIDPipe({ version: "4" })) subschemaId: string,
    @Body() body: UpdateWorkflowSubschemaDto,
  ): Promise<WorkflowSubschemaResponseDto> {
    return this.subschemas.updateSubschema(
      getRequiredOrganizationId(organizationIdHeader),
      subschemaId,
      body,
    );
  }
}
