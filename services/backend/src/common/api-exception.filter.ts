import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";

import type { ApiErrorBody, ErrorDiagnostics } from "./api-error.dto";
import type { RequestWithRequestId } from "./request-id.middleware";

interface StructuredExceptionResponse {
  code?: unknown;
  description?: unknown;
  diagnostics?: unknown;
  error?: unknown;
  humanMessage?: unknown;
  message?: unknown;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithRequestId>();
    const response = context.getResponse<Response>();
    const status = this.getStatus(exception);

    response.status(status).json(this.toErrorBody(exception, status, request.requestId));
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }

    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private toErrorBody(exception: unknown, status: number, requestId?: string): ApiErrorBody {
    if (exception instanceof HttpException) {
      const rawResponse = exception.getResponse();
      const structured =
        typeof rawResponse === "object" && rawResponse !== null
          ? (rawResponse as StructuredExceptionResponse)
          : undefined;

      return {
        code: this.stringOrDefault(structured?.code, this.defaultCode(status)),
        description: this.stringOrDefault(
          structured?.description ?? structured?.error,
          exception.name,
        ),
        diagnostics: this.objectOrUndefined(structured?.diagnostics),
        humanMessage: this.stringOrDefault(
          structured?.humanMessage ?? this.firstMessage(structured?.message) ?? rawResponse,
          this.defaultHumanMessage(status),
        ),
        requestId: requestId ?? "unknown",
      };
    }

    return {
      code: "INTERNAL_ERROR",
      description: "Unhandled exception",
      humanMessage: "Внутренняя ошибка сервера.",
      requestId: requestId ?? "unknown",
    };
  }

  private defaultCode(status: number): string {
    if (status === HttpStatus.BAD_REQUEST) {
      return "BAD_REQUEST";
    }

    if (status === HttpStatus.NOT_FOUND) {
      return "NOT_FOUND";
    }

    if (status === HttpStatus.CONFLICT) {
      return "CONFLICT";
    }

    return status >= 500 ? "INTERNAL_ERROR" : `HTTP_${status}`;
  }

  private defaultHumanMessage(status: number): string {
    return status >= 500 ? "Внутренняя ошибка сервера." : "Запрос не может быть обработан.";
  }

  private firstMessage(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      return value.find((item): item is string => typeof item === "string");
    }

    return typeof value === "string" ? value : undefined;
  }

  private objectOrUndefined(value: unknown): ErrorDiagnostics | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as ErrorDiagnostics;
    }

    return undefined;
  }

  private stringOrDefault(value: unknown, fallback: string): string {
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }
}
