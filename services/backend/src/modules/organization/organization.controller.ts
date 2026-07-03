import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  Version,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { ACTOR_USER_ID_HEADER, getOptionalActorUserId } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { OrganizationResponseDto, UpdateOrganizationDto } from "./organization.dto";
import { OrganizationService } from "./organization.service";

@ApiTags("organizations")
@Controller("organizations")
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get(":id")
  @Version("1")
  @ApiOperation({ summary: "Get organization by id" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  getOrganization(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<OrganizationResponseDto> {
    return this.organizations.getOrganization(id);
  }

  @Patch(":id")
  @Version("1")
  @ApiOperation({ summary: "Update organization settings" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  updateOrganization(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: UpdateOrganizationDto,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<OrganizationResponseDto> {
    return this.organizations.updateOrganization(id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
