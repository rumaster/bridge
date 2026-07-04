import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Put,
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
import {
  OrganizationConfigurationResponseDto,
  PutOrganizationConfigurationDto,
} from "./configuration.dto";
import { ConfigurationService } from "./configuration.service";

@ApiTags("configuration")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("organizations/:organizationId/configuration")
export class ConfigurationController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "Get organization configuration" })
  @ApiOkResponse({ type: OrganizationConfigurationResponseDto })
  getConfiguration(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
  ): Promise<OrganizationConfigurationResponseDto> {
    return this.configuration.getOrganizationConfiguration(organizationId);
  }

  @Put()
  @Version("1")
  @ApiOperation({ summary: "Replace organization configuration and record history" })
  @ApiOkResponse({ type: OrganizationConfigurationResponseDto })
  putConfiguration(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Body() body: PutOrganizationConfigurationDto,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<OrganizationConfigurationResponseDto> {
    return this.configuration.putOrganizationConfiguration(organizationId, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
