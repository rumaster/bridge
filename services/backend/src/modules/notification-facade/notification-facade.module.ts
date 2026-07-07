import { Module } from "@nestjs/common";

import { NotificationFacadeController } from "./notification-facade.controller";
import { NotificationFacade } from "./notification-facade.facade";
import { createNotificationGrpcUpstreamClientFromEnv } from "./notification-grpc-upstream.client";
import { NOTIFICATION_UPSTREAM_CLIENT } from "./notification-facade.upstream";
import type { NotificationUpstreamClient } from "./notification-facade.upstream";

@Module({
  controllers: [NotificationFacadeController],
  exports: [NotificationFacade],
  providers: [
    {
      provide: NotificationFacade,
      inject: [NOTIFICATION_UPSTREAM_CLIENT],
      useFactory: (upstream: NotificationUpstreamClient | null) =>
        new NotificationFacade({}, upstream),
    },
    {
      provide: NOTIFICATION_UPSTREAM_CLIENT,
      useFactory: () => createNotificationGrpcUpstreamClientFromEnv(),
    },
  ],
})
export class NotificationFacadeModule {}
