import { Module } from "@nestjs/common";

import { ChannelsController, ChannelTestController } from "./channels.controller";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";
import {
  INTEGRATION_GATEWAY_UPSTREAM_CLIENT,
  createIntegrationGatewayHttpUpstreamClientFromEnv,
  type IntegrationGatewayUpstreamClient,
} from "./integration-gateway.upstream";

@Module({
  controllers: [ChannelsController, ChannelTestController],
  exports: [IntegrationGatewayFacade],
  providers: [
    {
      provide: INTEGRATION_GATEWAY_UPSTREAM_CLIENT,
      useFactory: () => createIntegrationGatewayHttpUpstreamClientFromEnv(),
    },
    {
      inject: [INTEGRATION_GATEWAY_UPSTREAM_CLIENT],
      provide: IntegrationGatewayFacade,
      useFactory: (upstream: IntegrationGatewayUpstreamClient | null) =>
        new IntegrationGatewayFacade({
          upstream,
        }),
    },
  ],
})
export class IntegrationGatewayModule {}
