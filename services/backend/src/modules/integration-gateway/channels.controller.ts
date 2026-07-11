import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import {
  ORGANIZATION_ID_HEADER,
  getRequiredOrganizationId,
} from "../../common/request-context";
import {
  ChannelResponseDto,
  ConnectChannelRequestDto,
  ConnectChannelResponseDto,
  UpdateChannelRequestDto,
} from "./integration-gateway.dto";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";

@ApiTags("channels")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("channels")
export class ChannelsController {
  constructor(private readonly integrationGateway: IntegrationGatewayFacade) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List connected channels" })
  @ApiOkResponse({ type: ChannelResponseDto, isArray: true })
  listChannels(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
  ): Promise<ChannelResponseDto[]> {
    return this.integrationGateway.listChannels(getRequiredOrganizationId(organizationIdHeader));
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Connect an omnichannel adapter" })
  @ApiCreatedResponse({ type: ConnectChannelResponseDto })
  async connectChannel(@Body() dto: ConnectChannelRequestDto): Promise<ConnectChannelResponseDto> {
    return {
      channel: await this.integrationGateway.connectChannel({
        organization_id: dto.organization_id,
        channel_type: dto.channel_type,
        name: dto.name,
        credentials_ref: dto.credentials_ref,
        credentials: dto.credentials,
        email_credentials: dto.email_credentials,
        config: dto.config,
      }),
    };
  }

  @Put(":id")
  @Version("1")
  @ApiOperation({ summary: "Update a channel and rotate its credentials" })
  @ApiOkResponse({ type: ConnectChannelResponseDto })
  async updateChannel(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id") channelId: string,
    @Body() dto: UpdateChannelRequestDto,
  ): Promise<ConnectChannelResponseDto> {
    return {
      channel: await this.integrationGateway.updateChannel({
        channel_id: channelId,
        organization_id: getRequiredOrganizationId(organizationIdHeader),
        name: dto.name,
        credentials: dto.credentials,
        email_credentials: dto.email_credentials,
        config: dto.config,
      }),
    };
  }

  @Get(":id/capabilities")
  @Version("1")
  @ApiOperation({ summary: "Return channel C6 capabilities" })
  @ApiOkResponse({ description: "C6.CapabilityDescriptor" })
  getCapabilities(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id") channelId: string,
  ): unknown {
    return this.integrationGateway.getChannelCapabilities(
      channelId,
      getRequiredOrganizationId(organizationIdHeader),
    );
  }
}

@ApiTags("channels")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("channels")
export class ChannelTestController {
  constructor(protected readonly integrationGateway: IntegrationGatewayFacade) {}

  @Post(":id\\:test")
  @Version("1")
  @HttpCode(200)
  @ApiOperation({ summary: "Test a connected channel" })
  @ApiOkResponse({ description: "Channel test result" })
  testChannel(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id") channelId: string,
  ): unknown {
    return this.integrationGateway.testChannel(
      channelId,
      getRequiredOrganizationId(organizationIdHeader),
    );
  }
}
