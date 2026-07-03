import { Body, Controller, Get, HttpCode, Param, Post, Version } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  ChannelResponseDto,
  ConnectChannelRequestDto,
  ConnectChannelResponseDto,
} from "./integration-gateway.dto";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";

@ApiTags("channels")
@Controller("channels")
export class ChannelsController {
  constructor(private readonly integrationGateway: IntegrationGatewayFacade) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List connected channels" })
  @ApiOkResponse({ type: ChannelResponseDto, isArray: true })
  listChannels(): ChannelResponseDto[] {
    return this.integrationGateway.listChannels();
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Connect a Web Chat channel skeleton" })
  @ApiCreatedResponse({ type: ConnectChannelResponseDto })
  connectChannel(@Body() dto: ConnectChannelRequestDto): ConnectChannelResponseDto {
    return {
      channel: this.integrationGateway.connectWebChatChannel({
        organization_id: dto.organization_id,
        name: dto.name,
        credentials_ref: dto.credentials_ref,
        config: dto.config,
      }),
    };
  }

  @Get(":id/capabilities")
  @Version("1")
  @ApiOperation({ summary: "Return channel C6 capabilities" })
  @ApiOkResponse({ description: "C6.CapabilityDescriptor" })
  getCapabilities(@Param("id") channelId: string): unknown {
    return this.integrationGateway.getChannelCapabilities(channelId);
  }
}

@ApiTags("channels")
@Controller("channels")
export class ChannelTestController {
  constructor(protected readonly integrationGateway: IntegrationGatewayFacade) {}

  @Post(":id\\:test")
  @Version("1")
  @HttpCode(200)
  @ApiOperation({ summary: "Test a connected channel" })
  @ApiOkResponse({ description: "Channel test result" })
  testChannel(@Param("id") channelId: string): unknown {
    return this.integrationGateway.testChannel(channelId);
  }
}
