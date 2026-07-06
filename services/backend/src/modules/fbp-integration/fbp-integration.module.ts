import { Module } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import { createFbpGrpcUpstreamClientFromEnv } from "./fbp-grpc-upstream.client";
import { FbpIntegrationController } from "./fbp-integration.controller";
import { FbpIntegrationFacade } from "./fbp-integration.facade";
import { FBP_UPSTREAM_CLIENT } from "./fbp-integration.upstream";
import type { FbpUpstreamClient } from "./fbp-integration.upstream";

@Module({
  controllers: [FbpIntegrationController],
  exports: [FbpIntegrationFacade],
  providers: [
    {
      provide: FBP_UPSTREAM_CLIENT,
      inject: [PgDatabase],
      useFactory: (database: PgDatabase) => createFbpGrpcUpstreamClientFromEnv(database),
    },
    {
      // The facade constructor takes a plain resilience-options object (not an
      // injectable), so it is built via a factory rather than class autowiring.
      provide: FbpIntegrationFacade,
      inject: [FBP_UPSTREAM_CLIENT],
      useFactory: (upstream: FbpUpstreamClient | null) => new FbpIntegrationFacade({}, upstream),
    },
  ],
})
export class FbpIntegrationModule {}
