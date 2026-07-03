import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import { ApiExceptionFilter } from "./common/api-exception.filter";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { IdempotencyInterceptor } from "./common/idempotency/idempotency.interceptor";
import { InMemoryIdempotencyStore } from "./common/idempotency/idempotency.store";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { RequestLoggingInterceptor } from "./common/request-logging.interceptor";
import { createValidationPipe } from "./common/validation.pipe";
import { ClientModule } from "./modules/client/client.module";
import { CommunicationCoreProxyModule } from "./modules/communication-core/communication-core-proxy.module";
import { ConfigurationModule } from "./modules/configuration/configuration.module";
import { HealthModule } from "./modules/health/health.module";
import { IntegrationGatewayModule } from "./modules/integration-gateway/integration-gateway.module";
import { OrganizationModule } from "./modules/organization/organization.module";
import { UserModule } from "./modules/user/user.module";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    HealthModule,
    IntegrationGatewayModule,
    OrganizationModule,
    ConfigurationModule,
    ClientModule,
    UserModule,
    CommunicationCoreProxyModule,
  ],
  providers: [
    InMemoryIdempotencyStore,
    {
      provide: APP_PIPE,
      useFactory: createValidationPipe,
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
