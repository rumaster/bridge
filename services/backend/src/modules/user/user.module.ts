import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import {
  AuthSessionController,
  OrganizationUsersController,
  UserController,
} from "./user.controller";
import { UserService } from "./user.service";

@Module({
  controllers: [OrganizationUsersController, UserController, AuthSessionController],
  imports: [AuditModule],
  providers: [UserService],
})
export class UserModule {}
