import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import {
  ListNotificationsQueryDto,
  UpdateNotificationSettingsRequestDto,
} from "./notification-facade.dto";
import { NotificationFacade } from "./notification-facade.facade";
import type {
  NotificationListFacadeResponse,
  NotificationReadFacadeResponse,
  NotificationSettingsFacadeResponse,
} from "./notification-facade.facade";
import { NOTIFICATION_UPSTREAM_CLIENT } from "./notification-facade.upstream";
import type { NotificationUpstreamClient } from "./notification-facade.upstream";

@ApiTags("notifications")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("manager")
@Controller("notifications")
export class NotificationFacadeController {
  constructor(
    private readonly facade: NotificationFacade,
    @Optional()
    @Inject(NOTIFICATION_UPSTREAM_CLIENT)
    private readonly upstream: NotificationUpstreamClient | null = null,
  ) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List current-user notifications through SVC-NOTIF facade" })
  @ApiOkResponse({ description: "C10.ListNotificationsResponse" })
  listNotifications(
    @Query() query: ListNotificationsQueryDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<NotificationListFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      user_id: currentUserId(request),
      status: query.status,
      category: query.category,
      cursor: query.cursor,
      limit: query.limit,
    };

    return this.facade.listNotifications(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as NotificationUpstreamClient).listNotifications(facadeRequest)
        : undefined,
    });
  }

  @Post(":id\\:read")
  @Version("1")
  @HttpCode(200)
  @ApiOperation({ summary: "Mark a current-user notification read through SVC-NOTIF facade" })
  @ApiOkResponse({ description: "C10.MarkNotificationReadResponse" })
  markNotificationRead(
    @Param("id") notificationId: string,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<NotificationReadFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      user_id: currentUserId(request),
      notification_id: notificationId,
    };

    return this.facade.markNotificationRead(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as NotificationUpstreamClient).markNotificationRead(facadeRequest)
        : undefined,
    });
  }

  @Get("settings")
  @Version("1")
  @ApiOperation({ summary: "Read current-user notification settings through SVC-NOTIF facade" })
  @ApiOkResponse({ description: "C10.NotificationSettingsResponse" })
  getNotificationSettings(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<NotificationSettingsFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      user_id: currentUserId(request),
    };

    return this.facade.getNotificationSettings(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as NotificationUpstreamClient).getNotificationSettings(facadeRequest)
        : undefined,
    });
  }

  @Put("settings")
  @Version("1")
  @ApiOperation({ summary: "Update current-user notification settings through SVC-NOTIF facade" })
  @ApiOkResponse({ description: "C10.NotificationSettingsResponse" })
  updateNotificationSettings(
    @Body() body: UpdateNotificationSettingsRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<NotificationSettingsFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      user_id: currentUserId(request),
      settings: body.settings,
    };

    return this.facade.updateNotificationSettings(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as NotificationUpstreamClient).updateNotificationSettings(facadeRequest)
        : undefined,
    });
  }
}

function currentUserId(request: Request): string {
  return (request as AuthenticatedRequest).auth?.user.id ?? "unknown";
}

function requestId(request: Request): string {
  return (request as RequestWithRequestId).requestId ?? "";
}
