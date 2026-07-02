import { randomUUID } from "node:crypto";

import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

export interface RequestWithRequestId extends Request {
  requestId?: string;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: RequestWithRequestId, response: Response, next: NextFunction): void {
    const incomingRequestId =
      (typeof request.header === "function" ? request.header(REQUEST_ID_HEADER) : undefined) ??
      request.headers[REQUEST_ID_HEADER];
    const requestId = Array.isArray(incomingRequestId)
      ? incomingRequestId[0]
      : incomingRequestId || randomUUID();

    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
