import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import {
  ACTOR_USER_ID_HEADER,
  getOptionalActorUserId,
  getRequiredOrganizationId,
  ORGANIZATION_ID_HEADER,
} from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import {
  CreateUserDto,
  LogoutSessionResponseDto,
  PatchUserDto,
  RevokeUserSessionsResponseDto,
  UserSessionListResponseDto,
  UserListResponseDto,
  UserResponseDto,
} from "./user.dto";
import { UserService } from "./user.service";

@ApiTags("users")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
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
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("users")
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get(":id/sessions")
  @Version("1")
  @ApiOperation({ summary: "List active sessions for a user in tenant scope" })
  @ApiOkResponse({ type: UserSessionListResponseDto })
  listUserSessions(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserSessionListResponseDto> {
    return this.users.listActiveUserSessions(
      getRequiredOrganizationId(organizationIdHeader),
      id,
      request.auth?.session.id,
    );
  }

  @Patch(":id")
  @Version("1")
  @ApiOperation({ summary: "Patch user in tenant scope" })
  @ApiOkResponse({ type: UserResponseDto })
  patchUser(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: PatchUserDto,
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
  ): Promise<UserResponseDto> {
    return this.users.patchUser(getRequiredOrganizationId(organizationIdHeader), id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      authenticatedUserId: request.auth?.user.id,
      requestId: request.requestId,
    });
  }

  @Post(":id/sessions\\:revoke")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({ summary: "Revoke active sessions for a user in tenant scope" })
  @ApiOkResponse({ type: RevokeUserSessionsResponseDto })
  revokeUserSessions(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Req() request: Request,
  ): Promise<RevokeUserSessionsResponseDto> {
    return this.users.revokeUserSessions(getRequiredOrganizationId(organizationIdHeader), id, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}

@ApiTags("auth")
@UseGuards(SessionAuthGuard)
@Controller("auth")
export class AuthSessionController {
  constructor(private readonly users: UserService) {}

  @Post("logout")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({ summary: "Logout current server session" })
  @ApiOkResponse({ type: LogoutSessionResponseDto })
  async logout(
    @Req() request: AuthenticatedRequest & RequestWithRequestId,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LogoutSessionResponseDto> {
    const result = await this.users.revokeOwnSession(request.auth!, {
      actorUserId: request.auth?.user.id,
      requestId: request.requestId,
    });

    response.setHeader(
      "set-cookie",
      "bridge_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
    );

    return result;
  }
}
