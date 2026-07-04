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
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import type { AuthenticatedRequest } from "../../common/auth/auth-context";
import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import {
  CreateBroadcastRequestDto,
  StartBroadcastRequestDto,
} from "./broadcast-facade.dto";
import { BroadcastFacade } from "./broadcast-facade.facade";
import type {
  BroadcastCreateFacadeResponse,
  BroadcastListFacadeResponse,
  BroadcastStartFacadeResponse,
  BroadcastStatsFacadeResponse,
} from "./broadcast-facade.facade";
import { BROADCAST_UPSTREAM_CLIENT } from "./broadcast-facade.upstream";
import type { BroadcastUpstreamClient } from "./broadcast-facade.upstream";

@ApiTags("broadcasts")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("manager")
@Controller("broadcasts")
export class BroadcastFacadeController {
  constructor(
    private readonly facade: BroadcastFacade,
    @Optional()
    @Inject(BROADCAST_UPSTREAM_CLIENT)
    private readonly upstream: BroadcastUpstreamClient | null = null,
  ) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List broadcasts through SVC-BCAST facade" })
  @ApiOkResponse({ description: "C8.ListBroadcastsResponse" })
  listBroadcasts(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<BroadcastListFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
    };

    return this.facade.listBroadcasts(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as BroadcastUpstreamClient).listBroadcasts(facadeRequest)
        : undefined,
    });
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Create a broadcast campaign through SVC-BCAST facade" })
  @ApiCreatedResponse({ description: "C8.CreateBroadcastResponse" })
  createBroadcast(
    @Body() body: CreateBroadcastRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<BroadcastCreateFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      created_by: currentUserId(request),
      name: body.name,
      template: { ...body.template },
      filter: { ...body.filter },
      schedule: { ...body.schedule },
      rate_limit: { ...body.rate_limit },
    };

    return this.facade.createBroadcast(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as BroadcastUpstreamClient).createBroadcast(facadeRequest)
        : undefined,
    });
  }

  @Post(":id\\:start")
  @Version("1")
  @HttpCode(200)
  @ApiOperation({ summary: "Start a broadcast campaign through SVC-BCAST facade" })
  @ApiOkResponse({ description: "C8.StartBroadcastResponse" })
  startBroadcast(
    @Param("id") broadcastId: string,
    @Body() body: StartBroadcastRequestDto,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<BroadcastStartFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      broadcast_id: broadcastId,
      started_by: currentUserId(request),
      mode: body.mode,
      scheduled_for: body.scheduled_for,
    };

    return this.facade.startBroadcast(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as BroadcastUpstreamClient).startBroadcast(facadeRequest)
        : undefined,
    });
  }

  @Get(":id/stats")
  @Version("1")
  @ApiOperation({ summary: "Read broadcast campaign stats through SVC-BCAST facade" })
  @ApiOkResponse({ description: "C8.BroadcastStatsResponse" })
  getBroadcastStats(
    @Param("id") broadcastId: string,
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Req() request: Request,
  ): Promise<BroadcastStatsFacadeResponse> {
    const facadeRequest = {
      request_id: requestId(request),
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      broadcast_id: broadcastId,
    };

    return this.facade.getBroadcastStats(facadeRequest, {
      call: this.upstream
        ? () => (this.upstream as BroadcastUpstreamClient).getBroadcastStats(facadeRequest)
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
