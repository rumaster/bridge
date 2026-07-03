import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { PaginationQueryDto } from "../../common/query/pagination-query.dto";
import {
  ACTOR_USER_ID_HEADER,
  getOptionalActorUserId,
  getRequiredOrganizationId,
  ORGANIZATION_ID_HEADER,
} from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import {
  AddClientEndpointDto,
  ClientEndpointResponseDto,
  ClientListResponseDto,
  ClientMergeResponseDto,
  ClientNoteResponseDto,
  ClientResponseDto,
  ClientTagResponseDto,
  CreateClientDto,
  CreateClientNoteDto,
  CreateClientTagDto,
  MergeClientsDto,
} from "./client.dto";
import { ClientService } from "./client.service";

@ApiTags("clients")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("manager")
@Controller("clients")
export class ClientController {
  constructor(private readonly clients: ClientService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List clients in tenant scope" })
  @ApiOkResponse({ type: ClientListResponseDto })
  listClients(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Query() query: PaginationQueryDto,
  ): Promise<ClientListResponseDto> {
    return this.clients.listClients(
      getRequiredOrganizationId(organizationIdHeader),
      query.limit ?? 50,
      query.q,
    );
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Create client in tenant scope" })
  @ApiCreatedResponse({ type: ClientResponseDto })
  createClient(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Body() body: CreateClientDto,
    @Req() request: Request,
  ): Promise<ClientResponseDto> {
    return this.clients.createClient(getRequiredOrganizationId(organizationIdHeader), body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }

  @Get(":id")
  @Version("1")
  @ApiOperation({ summary: "Get client by id in tenant scope" })
  @ApiOkResponse({ type: ClientResponseDto })
  getClient(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<ClientResponseDto> {
    return this.clients.getClient(getRequiredOrganizationId(organizationIdHeader), id);
  }

  @Post(":id/notes")
  @Version("1")
  @ApiOperation({ summary: "Create client note" })
  @ApiCreatedResponse({ type: ClientNoteResponseDto })
  addNote(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: CreateClientNoteDto,
    @Req() request: Request,
  ): Promise<ClientNoteResponseDto> {
    return this.clients.addNote(getRequiredOrganizationId(organizationIdHeader), id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }

  @Post(":id/tags")
  @Version("1")
  @ApiOperation({ summary: "Create client tag" })
  @ApiCreatedResponse({ type: ClientTagResponseDto })
  addTag(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: CreateClientTagDto,
    @Req() request: Request,
  ): Promise<ClientTagResponseDto> {
    return this.clients.addTag(getRequiredOrganizationId(organizationIdHeader), id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }

  @Post(":id/endpoints")
  @Version("1")
  @ApiOperation({ summary: "Proxy client endpoint creation to Communication Core" })
  @ApiCreatedResponse({ type: ClientEndpointResponseDto })
  addEndpoint(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AddClientEndpointDto,
    @Req() request: Request,
  ): Promise<ClientEndpointResponseDto> {
    return this.clients.addEndpoint(getRequiredOrganizationId(organizationIdHeader), id, body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}

@ApiTags("clients")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("manager")
@Controller("clients\\:merge")
export class ClientMergeController {
  constructor(private readonly clients: ClientService) {}

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Proxy client merge to Communication Core" })
  @ApiCreatedResponse({ type: ClientMergeResponseDto })
  mergeClients(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Body() body: MergeClientsDto,
    @Req() request: Request,
  ): Promise<ClientMergeResponseDto> {
    return this.clients.mergeClients(getRequiredOrganizationId(organizationIdHeader), body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
