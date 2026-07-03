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
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { PaginationQueryDto } from "../../common/query/pagination-query.dto";
import {
  ACTOR_USER_ID_HEADER,
  getOptionalActorUserId,
  getRequiredOrganizationId,
  IDEMPOTENCY_KEY_HEADER,
  ORGANIZATION_ID_HEADER,
} from "../../common/request-context";
import type { RequestWithRequestId } from "../../common/request-id.middleware";
import {
  ConversationListResponseDto,
  ConversationResponseDto,
  CreateMessageDto,
  MessageListResponseDto,
  MessageResponseDto,
} from "./communication-core.dto";
import { CommunicationCoreProxyService } from "./communication-core-proxy.service";

@ApiTags("conversations")
@Controller("conversations")
export class ConversationController {
  constructor(private readonly core: CommunicationCoreProxyService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "Proxy conversation list from Communication Core" })
  @ApiOkResponse({ type: ConversationListResponseDto })
  listConversations(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Query() query: PaginationQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.core.listConversations(
      getRequiredOrganizationId(organizationIdHeader),
      query.limit ?? 50,
    );
  }

  @Get(":id")
  @Version("1")
  @ApiOperation({ summary: "Proxy conversation by id from Communication Core" })
  @ApiOkResponse({ type: ConversationResponseDto })
  getConversation(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<ConversationResponseDto> {
    return this.core.getConversation(getRequiredOrganizationId(organizationIdHeader), id);
  }

  @Get(":id/messages")
  @Version("1")
  @ApiOperation({ summary: "Proxy conversation messages from Communication Core" })
  @ApiOkResponse({ type: MessageListResponseDto })
  listMessages(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<MessageListResponseDto> {
    return this.core.listConversationMessages(
      getRequiredOrganizationId(organizationIdHeader),
      id,
      query.limit ?? 50,
    );
  }
}

@ApiTags("messages")
@Controller("messages")
export class MessageController {
  constructor(private readonly core: CommunicationCoreProxyService) {}

  @Get(":id")
  @Version("1")
  @ApiOperation({ summary: "Proxy message by id from Communication Core" })
  @ApiOkResponse({ type: MessageResponseDto })
  getMessage(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<MessageResponseDto> {
    return this.core.getMessage(getRequiredOrganizationId(organizationIdHeader), id);
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Idempotently proxy outbound message creation to Communication Core" })
  @ApiCreatedResponse({ type: MessageResponseDto })
  createMessage(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Headers(ACTOR_USER_ID_HEADER) actorUserIdHeader: string | string[] | undefined,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: CreateMessageDto,
    @Req() request: Request,
  ): Promise<MessageResponseDto> {
    const idempotencyKey = Array.isArray(idempotencyKeyHeader)
      ? idempotencyKeyHeader[0]
      : idempotencyKeyHeader;

    return this.core.createMessage(getRequiredOrganizationId(organizationIdHeader), body, {
      actorUserId: getOptionalActorUserId(actorUserIdHeader),
      idempotencyKey,
      requestId: (request as RequestWithRequestId).requestId,
    });
  }
}
