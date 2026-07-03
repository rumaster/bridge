import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { ACTOR_USER_ID_HEADER, getOptionalActorUserId } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { OrganizationResponseDto, UpdateOrganizationDto } from "./organization.dto";
import { OrganizationService } from "./organization.service";

@ApiTags("organizations")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("organizations")
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get(":organizationId")
  @Version("1")
  @ApiOperation({ summary: "Get organization by id" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  getOrganization(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
  ): Promise<OrganizationResponseDto> {
    return this.organizations.getOrganization(organizationId);
  }

  @Patch(":organizationId")
  @Version("1")
  @ApiOperation({ summary: "Update organization settings" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  updateOrganization(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Body() body: UpdateOrganizationDto,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<OrganizationResponseDto> {
    return this.organizations.updateOrganization(organizationId, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
