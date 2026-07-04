import { Module } from "@nestjs/common";

import { NotificationFacadeController } from "./notification-facade.controller";
import { NotificationFacade } from "./notification-facade.facade";
import { NOTIFICATION_UPSTREAM_CLIENT } from "./notification-facade.upstream";

@Module({
  controllers: [NotificationFacadeController],
  exports: [NotificationFacade],
  providers: [
    {
      provide: NotificationFacade,
      useFactory: () => new NotificationFacade(),
    },
    {
      provide: NOTIFICATION_UPSTREAM_CLIENT,
      useValue: null,
    },
  ],
})
export class NotificationFacadeModule {}
