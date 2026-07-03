import { Global, Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { RolesGuard } from "./roles.guard";
import { SessionAuthGuard } from "./session-auth.guard";

@Global()
@Module({
  exports: [RolesGuard, SessionAuthGuard],
  imports: [DatabaseModule],
  providers: [RolesGuard, SessionAuthGuard],
})
export class AuthModule {}
