import { Global, Module } from "@nestjs/common";

import { PgDatabase } from "./database.service";

@Global()
@Module({
  exports: [PgDatabase],
  providers: [PgDatabase],
})
export class DatabaseModule {}
