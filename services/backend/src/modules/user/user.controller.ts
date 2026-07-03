import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  ACTOR_USER_ID_HEADER,
  getOptionalActorUserId,
  getRequiredOrganizationId,
  ORGANIZATION_ID_HEADER,
} from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import { CreateUserDto, PatchUserDto, UserListResponseDto, UserResponseDto } from "./user.dto";
import { UserService } from "./user.service";

@ApiTags("users")
@Controller("organizations/:organizationId/users")
export class OrganizationUsersController {
  constructor(private readonly users: UserService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List organization users" })
  @ApiOkResponse({ type: UserListResponseDto })
  listUsers(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
  ): Promise<{ items: UserResponseDto[] }> {
    return this.users.listUsers(organizationId);
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Create organization user" })
  @ApiCreatedResponse({ type: UserResponseDto })
  createUser(
    @Param("organizationId", new ParseUUIDPipe({ version: "4" })) organizationId: string,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Body() body: CreateUserDto,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.createUser(organizationId, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}

@ApiTags("users")
@Controller("users")
export class UserController {
  constructor(private readonly users: UserService) {}

  @Patch(":id")
  @Version("1")
  @ApiOperation({ summary: "Patch user in tenant scope" })
  @ApiOkResponse({ type: UserResponseDto })
  patchUser(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: PatchUserDto,
    @Req() request: Request,
  ): Promise<UserResponseDto> {
    return this.users.patchUser(getRequiredOrganizationId(organizationIdHeader), id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
