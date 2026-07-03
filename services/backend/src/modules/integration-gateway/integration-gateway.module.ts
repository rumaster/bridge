import { Module } from "@nestjs/common";

import { ChannelsController, ChannelTestController } from "./channels.controller";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";

@Module({
  controllers: [ChannelsController, ChannelTestController],
  exports: [IntegrationGatewayFacade],
  providers: [IntegrationGatewayFacade],
})
export class IntegrationGatewayModule {}
