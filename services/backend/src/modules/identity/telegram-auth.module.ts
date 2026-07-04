import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { TelegramAuthController } from "./telegram-auth.controller";
import { TelegramAuthService } from "./telegram-auth.service";
import { TelegramCodeDeliveryService } from "./telegram-bot.service";

@Module({
  controllers: [TelegramAuthController],
  exports: [TelegramAuthService, TelegramCodeDeliveryService],
  imports: [AuditModule],
  providers: [TelegramAuthService, TelegramCodeDeliveryService],
})
export class TelegramAuthModule {}
