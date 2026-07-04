import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import {
  InvitationsController,
  PlatformOrganizationsController,
} from "./identity-m4.controller";
import { IdentityM4Service } from "./identity-m4.service";

@Module({
  controllers: [PlatformOrganizationsController, InvitationsController],
  imports: [AuditModule],
  providers: [IdentityM4Service],
})
export class IdentityM4Module {}
