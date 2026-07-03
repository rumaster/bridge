import {
  Body,
  Controller,
  Headers,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { StartWorkflowRequestDto } from "./fbp-integration.dto";
import { FbpIntegrationFacade } from "./fbp-integration.facade";
import type { FbpStartWorkflowFacadeResponse } from "./fbp-integration.facade";
import { FBP_UPSTREAM_CLIENT } from "./fbp-integration.upstream";
import type { FbpUpstreamClient } from "./fbp-integration.upstream";

/**
 * Thin C5 FBP facade surface (ТЗ §6.13, §11.2). Starting a Workflow instance is
 * always initiated by the Backend on behalf of the acting user — never the AI —
 * and degrades gracefully to a controlled "degraded" response when SVC-FBP is
 * slow or unavailable (ТЗ §11.11) instead of crashing the core.
 */
@ApiTags("fbp-integration")
@UseGuards(SessionAuthGuard, RolesGuard)
@Controller("fbp/workflows")
export class FbpIntegrationController {
  constructor(
    private readonly facade: FbpIntegrationFacade,
    @Optional()
    @Inject(FBP_UPSTREAM_CLIENT)
    private readonly upstream: FbpUpstreamClient | null = null,
  ) {}

  @Post(":workflowId\\:start")
  @Version("1")
  @Roles("manager")
  @ApiOperation({ summary: "Start a Workflow instance (initiated by the Backend, degrades safely)" })
  startWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: StartWorkflowRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<FbpStartWorkflowFacadeResponse> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const requestId = (request as RequestWithRequestId).requestId ?? "";
    const facadeRequest = {
      request_id: requestId,
      organization_id: organizationId,
      workflow_id: workflowId,
      workflow_version_id: body.workflow_version_id,
      actor_user_id: body.actor_user_id,
      input: body.input,
    };

    return this.facade.startWorkflowInstance(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as FbpUpstreamClient).startWorkflowInstance(facadeRequest)
        : undefined,
    });
  }
}
