import { Global, Module } from "@nestjs/common";

import { ChannelSecretService } from "./channel-secret.service";

/**
 * Глобальный модуль секретов каналов (DR-03, Этап T0
 * `docs/plan/telegram-channel-production.md`).
 *
 * Предоставляет {@link ChannelSecretService} всему backend. Зависит от глобального
 * {@link DatabaseModule} (`PgDatabase`). Envelope-ключ читается лениво, поэтому
 * импорт модуля не требует `CHANNEL_SECRET_ENCRYPTION_KEY` на этапе bootstrap.
 */
@Global()
@Module({
  exports: [ChannelSecretService],
  providers: [ChannelSecretService],
})
export class SecretsModule {}
