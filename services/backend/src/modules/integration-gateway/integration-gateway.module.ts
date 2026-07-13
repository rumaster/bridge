import { Module } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import { ChannelSecretService } from "../../common/secrets/channel-secret.service";
import { ChannelsController, ChannelTestController } from "./channels.controller";
import { InternalChannelSecretController } from "./internal-channels.controller";
import { MailController } from "./mail.controller";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";
import {
  INTEGRATION_GATEWAY_UPSTREAM_CLIENT,
  createIntegrationGatewayHttpUpstreamClientFromEnv,
  type IntegrationGatewayUpstreamClient,
} from "./integration-gateway.upstream";

@Module({
  controllers: [
    ChannelsController,
    ChannelTestController,
    InternalChannelSecretController,
    MailController,
  ],
  exports: [IntegrationGatewayFacade],
  providers: [
    {
      provide: INTEGRATION_GATEWAY_UPSTREAM_CLIENT,
      useFactory: () => createIntegrationGatewayHttpUpstreamClientFromEnv(),
    },
    {
      inject: [PgDatabase, ChannelSecretService, INTEGRATION_GATEWAY_UPSTREAM_CLIENT],
      provide: IntegrationGatewayFacade,
      useFactory: (
        database: PgDatabase,
        channelSecrets: ChannelSecretService,
        upstream: IntegrationGatewayUpstreamClient | null,
      ) =>
        new IntegrationGatewayFacade({
          channelSecrets,
          database,
          upstream,
        }),
    },
  ],
})
export class IntegrationGatewayModule {}
