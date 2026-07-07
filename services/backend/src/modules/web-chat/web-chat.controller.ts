import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  MessageListResponseDto,
  MessageResponseDto,
} from "../communication-core/communication-core.dto";
import {
  CreateOrResumeWebChatSessionDto,
  SendWebChatMessageDto,
  StartWebChatEmailCodeDto,
  VerifyWebChatEmailCodeDto,
  WebChatEmailCodeStartResponseDto,
  WebChatMessagesQueryDto,
  WebChatSessionResponseDto,
} from "./web-chat.dto";
import { WebChatService } from "./web-chat.service";

@ApiTags("web-chat")
@Controller("web-chat")
export class WebChatController {
  constructor(private readonly webChat: WebChatService) {}

  @Post("sessions")
  @Version("1")
  @ApiOperation({ summary: "Create or resume anonymous Web Chat session" })
  @ApiCreatedResponse({ type: WebChatSessionResponseDto })
  createOrResumeSession(
    @Body() body: CreateOrResumeWebChatSessionDto,
  ): Promise<WebChatSessionResponseDto> {
    return this.webChat.createOrResumeSession(body);
  }

  @Get("conversations/:id/messages")
  @Version("1")
  @ApiOperation({ summary: "List messages visible to a Web Chat visitor session" })
  @ApiOkResponse({ type: MessageListResponseDto })
  listMessages(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query() query: WebChatMessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    return this.webChat.listMessages(id, query);
  }

  @Post("messages")
  @Version("1")
  @ApiOperation({ summary: "Send an inbound Web Chat visitor message" })
  @ApiCreatedResponse({ type: MessageResponseDto })
  sendMessage(@Body() body: SendWebChatMessageDto): Promise<MessageResponseDto> {
    return this.webChat.sendMessage(body);
  }

  @Post("email-code")
  @Version("1")
  @ApiOperation({ summary: "Start optional Web Chat email verification by code" })
  @ApiCreatedResponse({ type: WebChatEmailCodeStartResponseDto })
  startEmailCode(
    @Body() body: StartWebChatEmailCodeDto,
  ): Promise<WebChatEmailCodeStartResponseDto> {
    return this.webChat.startEmailCode(body);
  }

  @Post("email-code\\:verify")
  @Version("1")
  @HttpCode(200)
  @ApiOperation({ summary: "Verify optional Web Chat email code" })
  @ApiOkResponse({ type: WebChatSessionResponseDto })
  verifyEmailCode(
    @Body() body: VerifyWebChatEmailCodeDto,
  ): Promise<WebChatSessionResponseDto> {
    return this.webChat.verifyEmailCode(body);
  }
}
