import {
  Body,
  Controller,
  Headers,
  Inject,
  Optional,
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
import { AiIntegrationFacade } from "./ai-integration.facade";
import type {
  AiAssistantFacadeResponse,
  AiOnboardingFacadeResponse,
} from "./ai-integration.facade";
import { AiAssistantSuggestRequestDto, AiOnboardingCommandRequestDto } from "./ai-integration.dto";
import { AI_UPSTREAM_CLIENT } from "./ai-integration.upstream";
import type { AiUpstreamClient } from "./ai-integration.upstream";

/**
 * Thin C4 AI facade surface (ТЗ §11.2). Both endpoints degrade gracefully when
 * SVC-AI is slow or unavailable — the conversation keeps working (ТЗ §5.4) — and
 * never let AI touch the database directly: the onboarding command is a
 * description only, applied later by the Backend API through
 * `POST /ai/onboarding:apply` after validation and a rights check (ТЗ §12.6).
 */
@ApiTags("ai-integration")
@UseGuards(SessionAuthGuard, RolesGuard)
@Controller("ai")
export class AiIntegrationController {
  constructor(
    private readonly facade: AiIntegrationFacade,
    @Optional()
    @Inject(AI_UPSTREAM_CLIENT)
    private readonly upstream: AiUpstreamClient | null = null,
  ) {}

  @Post("assistant\\:suggest")
  @Version("1")
  @Roles("manager")
  @ApiOperation({ summary: "Request an AI assistant suggestion (degrades to a safe fallback)" })
  suggestAssistant(
    @Body() body: AiAssistantSuggestRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<AiAssistantFacadeResponse> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const requestId = (request as RequestWithRequestId).requestId ?? "";
    const facadeRequest = {
      request_id: requestId,
      organization_id: organizationId,
      query: body.query,
    };

    return this.facade.suggestAssistant(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as AiUpstreamClient).suggestAssistant(facadeRequest)
        : undefined,
    });
  }

  @Post("onboarding\\:command")
  @Version("1")
  @Roles("administrator")
  @ApiOperation({ summary: "Generate a structured AI onboarding command (never auto-applied)" })
  createOnboardingCommand(
    @Body() body: AiOnboardingCommandRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<AiOnboardingFacadeResponse> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const requestId = (request as RequestWithRequestId).requestId ?? "";
    const facadeRequest = {
      request_id: requestId,
      organization_id: organizationId,
      prompt: body.prompt,
    };

    return this.facade.createOnboardingCommand(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as AiUpstreamClient).createOnboardingCommand(facadeRequest)
        : undefined,
    });
  }
}
