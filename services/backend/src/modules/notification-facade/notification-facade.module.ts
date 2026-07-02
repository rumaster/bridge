import { Module } from "@nestjs/common";

import { NotificationFacade } from "./notification-facade.facade";

@Module({
  exports: [NotificationFacade],
  providers: [NotificationFacade],
})
export class NotificationFacadeModule {}
