import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Response } from "express";
import { Observable, catchError, of, tap, throwError } from "rxjs";

import type { RequestWithRequestId } from "../request-id.middleware";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
} from "./idempotency.constants";
import { InMemoryIdempotencyStore } from "./idempotency.store";

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: InMemoryIdempotencyStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithRequestId>();
    const response = http.getResponse<Response>();

    if (request.method.toUpperCase() !== "POST") {
      return next.handle();
    }

    const idempotencyKey = this.getHeader(request, IDEMPOTENCY_KEY_HEADER);
    if (!idempotencyKey) {
      return next.handle();
    }

    const key = `${request.method}:${request.originalUrl ?? request.url}:${idempotencyKey}`;
    const fingerprint = stableStringify({
      body: request.body,
      method: request.method,
      path: request.originalUrl ?? request.url,
      query: request.query,
    });
    const reservation = this.store.reserve(key, fingerprint);

    if (reservation.kind === "replay") {
      response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
      if (reservation.entry.statusCode) {
        response.status(reservation.entry.statusCode);
      }

      return of(reservation.entry.responseBody);
    }

    if (reservation.kind === "pending") {
      throw new ConflictException({
        code: "IDEMPOTENCY_REQUEST_PENDING",
        description: "Idempotent request is already being processed",
        humanMessage: "Запрос с этим ключом идемпотентности уже выполняется.",
      });
    }

    if (reservation.kind === "conflict") {
      throw new ConflictException({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        description: "Idempotency key was already used for a different request",
        humanMessage: "Ключ идемпотентности уже использован для другого запроса.",
      });
    }

    return next.handle().pipe(
      tap((responseBody) => {
        this.store.commit(key, fingerprint, response.statusCode, responseBody);
      }),
      catchError((error: unknown) => {
        this.store.release(key, fingerprint);
        return throwError(() => error);
      }),
    );
  }

  private getHeader(request: RequestWithRequestId, headerName: string): string | undefined {
    const value = request.header(headerName) ?? request.headers[headerName];
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
