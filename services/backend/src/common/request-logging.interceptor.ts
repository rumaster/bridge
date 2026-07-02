import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { Response } from "express";
import { Observable, tap } from "rxjs";

import type { RequestWithRequestId } from "./request-id.middleware";

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithRequestId>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.logRequest(request, response, startedAt),
        error: () => this.logRequest(request, response, startedAt),
      }),
    );
  }

  private logRequest(
    request: RequestWithRequestId,
    response: Response,
    startedAt: number,
  ): void {
    this.logger.debug({
      durationMs: Date.now() - startedAt,
      method: request.method,
      path: request.originalUrl ?? request.url,
      requestId: request.requestId,
      statusCode: response.statusCode,
    });
  }
}
