import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { RegistrationController } from "./registration.controller";
import { RegistrationService } from "./registration.service";
import { TelegramAuthController } from "./telegram-auth.controller";
import { TelegramAuthService } from "./telegram-auth.service";
import { TelegramCodeDeliveryService } from "./telegram-bot.service";
import { TelegramUpdatesPoller } from "./telegram-updates.poller";

@Module({
  controllers: [TelegramAuthController, RegistrationController],
  exports: [TelegramAuthService, TelegramCodeDeliveryService, RegistrationService],
  imports: [AuditModule],
  providers: [
    TelegramAuthService,
    TelegramCodeDeliveryService,
    RegistrationService,
    TelegramUpdatesPoller,
  ],
})
export class TelegramAuthModule {}
