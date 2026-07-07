import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import {
  CreateWorkflowVersionDto,
  UpdateWorkflowDto,
  WorkflowInstanceDetailResponseDto,
  WorkflowInstanceResponseDto,
  WorkflowResponseDto,
  WorkflowVersionResponseDto,
} from "./workflow.dto";
import { WorkflowService } from "./workflow.service";

@ApiTags("workflows")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("platform_operator")
@Controller("workflows")
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List tenant Workflow definitions" })
  @ApiOkResponse({ type: WorkflowResponseDto, isArray: true })
  listWorkflows(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
  ): Promise<WorkflowResponseDto[]> {
    return this.workflows.listWorkflows(getRequiredOrganizationId(organizationIdHeader));
  }

  @Get(":workflowId/versions")
  @Version("1")
  @ApiOperation({ summary: "List immutable Workflow versions" })
  @ApiOkResponse({ type: WorkflowVersionResponseDto, isArray: true })
  listVersions(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
  ): Promise<WorkflowVersionResponseDto[]> {
    return this.workflows.listVersions(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
    );
  }

  @Post(":workflowId/versions")
  @Version("1")
  @ApiOperation({ summary: "Create an immutable Workflow version" })
  @ApiCreatedResponse({ type: WorkflowVersionResponseDto })
  createVersion(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Body() body: CreateWorkflowVersionDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkflowVersionResponseDto> {
    return this.workflows.createVersion(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      body,
      request.auth?.user.id,
    );
  }

  @Patch(":workflowId")
  @Version("1")
  @ApiOperation({ summary: "Update Workflow status/default version" })
  @ApiOkResponse({ type: WorkflowResponseDto })
  updateWorkflow(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Body() body: UpdateWorkflowDto,
  ): Promise<WorkflowResponseDto> {
    return this.workflows.updateWorkflow(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      body,
    );
  }

  @Get(":workflowId/instances")
  @Version("1")
  @ApiOperation({ summary: "List Workflow execution instances" })
  @ApiOkResponse({ type: WorkflowInstanceResponseDto, isArray: true })
  listInstances(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
  ): Promise<WorkflowInstanceResponseDto[]> {
    return this.workflows.listInstances(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
    );
  }

  @Get(":workflowId/instances/:instanceId")
  @Version("1")
  @ApiOperation({ summary: "Read Workflow execution instance details" })
  @ApiOkResponse({ type: WorkflowInstanceDetailResponseDto })
  getInstance(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Param("instanceId", new ParseUUIDPipe({ version: "4" })) instanceId: string,
  ): Promise<WorkflowInstanceDetailResponseDto> {
    return this.workflows.getInstance(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      instanceId,
    );
  }
}
