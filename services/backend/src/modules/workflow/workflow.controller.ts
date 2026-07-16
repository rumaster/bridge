import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
  ImportWorkflowSchemaDto,
  SaveWorkflowDraftDto,
  TestWorkflowDraftDto,
  UpdateWorkflowDto,
  WorkflowDraftResponseDto,
  WorkflowDraftTestResponseDto,
  WorkflowImportResponseDto,
  WorkflowInstanceDetailResponseDto,
  WorkflowInstanceResponseDto,
  WorkflowResponseDto,
  WorkflowSchemaExportResponseDto,
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

  @Get(":workflowId/export")
  @Version("1")
  @ApiOperation({ summary: "Export the active Workflow schema as JSON" })
  @ApiOkResponse({ type: WorkflowSchemaExportResponseDto })
  exportWorkflow(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
  ): Promise<WorkflowSchemaExportResponseDto> {
    return this.workflows.exportWorkflow(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
    );
  }

  @Post(":workflowId/import")
  @Version("1")
  @ApiOperation({ summary: "Import a Workflow schema JSON into draft or immutable version" })
  @ApiOkResponse({ type: WorkflowImportResponseDto })
  importWorkflow(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Body() body: ImportWorkflowSchemaDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkflowImportResponseDto> {
    return this.workflows.importWorkflow(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      body,
      request.auth?.user.id,
    );
  }

  @Get(":workflowId/draft")
  @Version("1")
  @ApiOperation({ summary: "Read persisted Workflow draft schema" })
  @ApiOkResponse({ type: WorkflowDraftResponseDto })
  getDraft(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
  ): Promise<WorkflowDraftResponseDto> {
    return this.workflows.getDraft(getRequiredOrganizationId(organizationIdHeader), workflowId);
  }

  @Patch(":workflowId/draft")
  @Version("1")
  @ApiOperation({ summary: "Persist Workflow draft schema" })
  @ApiOkResponse({ type: WorkflowDraftResponseDto })
  saveDraft(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Body() body: SaveWorkflowDraftDto,
  ): Promise<WorkflowDraftResponseDto> {
    return this.workflows.saveDraft(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      body,
    );
  }

  /**
   * Тест-прогон драфта (дефект D5). Гоняется СОХРАНЁННЫЙ драфт: схема в теле не
   * передаётся, редактор автосохраняет её перед прогоном — так исключается
   * расхождение «протестировали одно, сохранили другое».
   */
  @Post(":workflowId/draft\\:test")
  @Version("1")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Test-run the Workflow draft without creating an instance" })
  @ApiOkResponse({ type: WorkflowDraftTestResponseDto })
  testDraft(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Body() body: TestWorkflowDraftDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkflowDraftTestResponseDto> {
    return this.workflows.testDraft(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      body,
      request.auth?.user.id,
      (request as AuthenticatedRequest & { requestId?: string }).requestId ?? "",
    );
  }

  @Post(":workflowId/draft\\:promote")
  @Version("1")
  @ApiOperation({ summary: "Promote Workflow draft to a new active immutable version" })
  @ApiCreatedResponse({ type: WorkflowVersionResponseDto })
  promoteDraft(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkflowVersionResponseDto> {
    return this.workflows.promoteDraft(
      getRequiredOrganizationId(organizationIdHeader),
      workflowId,
      request.auth?.user.id,
    );
  }

  @Delete(":workflowId/draft")
  @Version("1")
  @ApiOperation({ summary: "Reset Workflow draft to the latest published schema" })
  @ApiOkResponse({ type: WorkflowDraftResponseDto })
  resetDraft(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("workflowId", new ParseUUIDPipe({ version: "4" })) workflowId: string,
  ): Promise<WorkflowDraftResponseDto> {
    return this.workflows.resetDraft(getRequiredOrganizationId(organizationIdHeader), workflowId);
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
