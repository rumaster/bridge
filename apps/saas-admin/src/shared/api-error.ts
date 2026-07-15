/**
 * Разбор тела ошибки бэкенда (ApiErrorBody: code / description / humanMessage /
 * diagnostics / requestId).
 *
 * ApiExceptionFilter на бэкенде оставляет в ответе только эти поля, поэтому любые
 * структурные детали ошибки приходят внутри `diagnostics` — например список
 * организаций при 409 ORGANIZATION_SELECTION_REQUIRED.
 */

export interface ApiErrorBody {
  code?: string;
  description?: string;
  diagnostics?: Record<string, unknown>;
  humanMessage?: string;
  requestId?: string;
}

export function getApiErrorBody(error: unknown): ApiErrorBody | null {
  if (typeof error !== "object" || error === null || !("body" in error)) {
    return null;
  }

  const body = (error as { body?: unknown }).body;

  return typeof body === "object" && body !== null ? (body as ApiErrorBody) : null;
}

export function getApiErrorCode(error: unknown): string | null {
  return getApiErrorBody(error)?.code ?? null;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const humanMessage = getApiErrorBody(error)?.humanMessage;
  if (humanMessage) {
    return humanMessage;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export function getApiErrorDiagnostics(error: unknown): Record<string, unknown> | null {
  return getApiErrorBody(error)?.diagnostics ?? null;
}
