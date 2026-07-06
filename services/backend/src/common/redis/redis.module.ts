import { Global, Module } from "@nestjs/common";

import { RedisInfrastructureService } from "./redis.service";

@Global()
@Module({
  exports: [RedisInfrastructureService],
  providers: [RedisInfrastructureService],
})
export class RedisInfrastructureModule {}
