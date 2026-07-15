import { Body, Controller, Get, Param, Patch, Req, UseGuards, Version } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { BackendApiAllowlistEntryDto, UpdateBackendApiAllowlistDto } from "./workflow.dto";
import { WorkflowBackendApiAllowlistService } from "./workflow-backend-api-allowlist.service";

/**
 * Курирование витрины вызовов Backend API (решение A3). Доступно только
 * platform_operator: узел backend-api — единственный, который меняет данные
 * (ТЗ §13.5), поэтому решение «что вообще можно дёргать из схемы» принимает
 * оператор платформы, а не администратор организации.
 */
@ApiTags("workflow-backend-api-allowlist")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("platform_operator")
@Controller("workflow-backend-api-allowlist")
export class WorkflowBackendApiAllowlistController {
  constructor(private readonly allowlist: WorkflowBackendApiAllowlistService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List Backend API operations available to Workflow nodes" })
  @ApiOkResponse({ type: BackendApiAllowlistEntryDto, isArray: true })
  listOperations(): Promise<BackendApiAllowlistEntryDto[]> {
    return this.allowlist.listOperations();
  }

  @Patch(":operationId")
  @Version("1")
  @ApiOperation({ summary: "Allow or forbid a Backend API operation for Workflow nodes" })
  @ApiOkResponse({ type: BackendApiAllowlistEntryDto })
  updateOperation(
    @Param("operationId") operationId: string,
    @Body() payload: UpdateBackendApiAllowlistDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<BackendApiAllowlistEntryDto> {
    return this.allowlist.setEnabled(operationId, payload.enabled, request.auth?.user.id, payload.note);
  }
}
