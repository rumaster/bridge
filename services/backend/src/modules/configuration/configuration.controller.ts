import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  Version,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { ACTOR_USER_ID_HEADER, getOptionalActorUserId } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { ConfigurationResponseDto, DEFAULT_CONFIGURATION_KEY, PutConfigurationDto } from "./configuration.dto";
import { ConfigurationService } from "./configuration.service";

@ApiTags("configuration")
@Controller("organizations/:organizationId/configuration")
export class ConfigurationController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "Get organization configuration" })
  @ApiOkResponse({ type: ConfigurationResponseDto })
  getConfiguration(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Query("key") key = DEFAULT_CONFIGURATION_KEY,
  ): Promise<ConfigurationResponseDto> {
    return this.configuration.getConfiguration(organizationId, key);
  }

  @Put()
  @Version("1")
  @ApiOperation({ summary: "Replace organization configuration and record history" })
  @ApiOkResponse({ type: ConfigurationResponseDto })
  putConfiguration(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Body() body: PutConfigurationDto,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<ConfigurationResponseDto> {
    return this.configuration.putConfiguration(organizationId, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
