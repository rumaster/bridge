import { Module } from "@nestjs/common";

import { AuditService } from "./audit.service";

@Module({
  exports: [AuditService],
  providers: [AuditService],
})
export class AuditModule {}
