import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import { ApiExceptionFilter } from "./common/api-exception.filter";
import { IdempotencyInterceptor } from "./common/idempotency/idempotency.interceptor";
import { InMemoryIdempotencyStore } from "./common/idempotency/idempotency.store";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { RequestLoggingInterceptor } from "./common/request-logging.interceptor";
import { createValidationPipe } from "./common/validation.pipe";
import { HealthModule } from "./modules/health/health.module";
import { IntegrationGatewayModule } from "./modules/integration-gateway/integration-gateway.module";

@Module({
  imports: [HealthModule, IntegrationGatewayModule],
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
