import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { OrganizationResponseDto } from "../organization/organization.dto";
import {
  AcceptInvitationDto,
  CreateFirstAdministratorInvitationDto,
  CreateInvitationDto,
  InvitationAcceptedSessionDto,
  InvitationResponseDto,
  ProvisionOrganizationDto,
} from "./identity-m4.dto";
import { IdentityM4Service } from "./identity-m4.service";

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

@ApiTags("platform")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("platform_operator")
@Controller("platform/organizations")
export class PlatformOrganizationsController {
  constructor(private readonly identity: IdentityM4Service) {}

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Provision an organization tenant" })
  @ApiCreatedResponse({ type: OrganizationResponseDto })
  provisionOrganization(
    @Body() body: ProvisionOrganizationDto,
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
  ): Promise<OrganizationResponseDto> {
    return this.identity.provisionOrganization(body, request.auth!, request.requestId);
  }

  @Post(":id/administrators")
  @Version("1")
  @ApiOperation({ summary: "Create first Administrator invitation" })
  @ApiCreatedResponse({ type: InvitationResponseDto })
  createFirstAdministratorInvitation(
    @Param("id", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Body() body: CreateFirstAdministratorInvitationDto,
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
  ): Promise<InvitationResponseDto> {
    return this.identity.createFirstAdministratorInvitation(
      organizationId,
      body,
      request.auth!,
      request.requestId,
    );
  }

  @Post(":id/block")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({ summary: "Block an organization tenant" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  blockOrganization(
    @Param("id", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
  ): Promise<OrganizationResponseDto> {
    return this.identity.blockOrganization(organizationId, request.auth!, request.requestId);
  }
}

@ApiTags("invitations")
@Controller("invitations")
export class InvitationsController {
  constructor(private readonly identity: IdentityM4Service) {}

  @Post()
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles("administrator")
  @Version("1")
  @ApiOperation({ summary: "Create an organization user invitation" })
  @ApiCreatedResponse({ type: InvitationResponseDto })
  createInvitation(
    @Body() body: CreateInvitationDto,
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
  ): Promise<InvitationResponseDto> {
    return this.identity.createInvitation(body, request.auth!, request.requestId);
  }

  @Post("accept")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({ summary: "Accept a one-time invitation token and create first session" })
  @ApiOkResponse({ type: InvitationAcceptedSessionDto })
  async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.identity.acceptInvitation(body, {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"]?.toString() ?? null,
    });

    if (typeof result.token === "string") {
      response.setHeader(
        "set-cookie",
        `bridge_session=${encodeURIComponent(
          result.token,
        )}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
      );
    }

    return result;
  }
}
