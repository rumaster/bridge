import { BadRequestException, Body, Controller, Headers, Post, Req, UseGuards, Version } from "@nestjs/common";
import { ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { BackendApiNodeInvokeDto, OnboardingApplyDto } from "./backend-api.dto";
import { WorkflowActionApplierService } from "./workflow-action-applier.service";
import type { AppliedActionResult } from "./workflow-action-applier.service";

interface AppliedActionResponse extends AppliedActionResult {
  organization_id: string;
  request_id: string;
}

interface BackendApiNodeResponse extends AppliedActionResult {
  contract: "C5.BackendApiNodeResult";
  version: "1.0.0";
  organization_id: string;
  workflow_id: string;
  workflow_version_id: string;
  instance_id: string;
  node_id: string;
  request_id: string;
}

/**
 * The Backend API node (C5, ТЗ §13.5) and AI Onboarding apply (C4, ТЗ §12.6):
 * the *only* sanctioned way an AI onboarding command or a Workflow node changes
 * data. Both routes forward the structured command to
 * {@link WorkflowActionApplierService}, which validates it against the frozen
 * §12.6 schema, authorizes the change against the current principal's real
 * rights, applies it via the owning domain service, and audits it with
 * `actor_type = ai | workflow` (ТЗ §22.9).
 */
@ApiTags("backend-api")
@UseGuards(SessionAuthGuard, RolesGuard)
@Controller()
export class BackendApiController {
  constructor(private readonly applier: WorkflowActionApplierService) {}

  @Post("ai/onboarding\\:apply")
  @Version("1")
  @Roles("administrator")
  @ApiOperation({ summary: "Apply a confirmed AI onboarding command (actor_type = ai)" })
  @ApiCreatedResponse({ description: "Applied Backend API action response" })
  async applyOnboarding(
    @Body() body: OnboardingApplyDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: AuthenticatedRequest,
  ): Promise<AppliedActionResponse> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const auth = requireAuth(request);
    const requestId = (request as RequestWithRequestId).requestId;

    const result = await this.applier.apply({
      command: body.command,
      organizationId,
      actorType: "ai",
      actorUserId: auth.user.id,
      roles: auth.roles,
      requestId,
    });

    return { ...result, organization_id: organizationId, request_id: requestId ?? "" };
  }

  @Post("workflows/backend-api-node\\:invoke")
  @Version("1")
  @Roles("manager")
  @ApiOperation({ summary: "Apply a change requested by a Workflow node (actor_type = workflow)" })
  @ApiCreatedResponse({ description: "C5.BackendApiNodeResult" })
  async invokeNode(
    @Body() body: BackendApiNodeInvokeDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: AuthenticatedRequest,
  ): Promise<BackendApiNodeResponse> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const auth = requireAuth(request);
    const requestId = (request as RequestWithRequestId).requestId;

    if (body.context.organization_id !== organizationId) {
      throw new BadRequestException({
        code: "TENANT_MISMATCH",
        description: "context.organization_id does not match the request tenant header.",
        humanMessage: "Контекст Workflow относится к другой организации.",
      });
    }

    // Rights are always evaluated against the *real* authenticated principal
    // (the calling session), never the roles the Workflow context declares —
    // this prevents a Workflow from escalating its own privileges (ТЗ §13.5).
    const result = await this.applier.apply({
      command: body.command,
      organizationId,
      actorType: "workflow",
      actorUserId: body.context.actor_user_id,
      roles: auth.roles,
      requestId,
    });

    return {
      contract: "C5.BackendApiNodeResult",
      version: "1.0.0",
      ...result,
      organization_id: organizationId,
      workflow_id: body.workflow_id,
      workflow_version_id: body.workflow_version_id,
      instance_id: body.instance_id,
      node_id: body.node_id,
      request_id: requestId ?? "",
    };
  }
}

function requireAuth(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest["auth"]> {
  if (!request.auth) {
    throw new BadRequestException({
      code: "AUTH_REQUIRED",
      description: "Authenticated session context is missing.",
      humanMessage: "Требуется аутентификация.",
    });
  }

  return request.auth;
}
