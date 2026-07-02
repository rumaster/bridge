import { BadRequestException, ValidationPipe } from "@nestjs/common";
import type { ValidationError } from "class-validator";

interface ValidationFieldDiagnostic {
  field: string;
  messages: string[];
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    whitelist: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: "VALIDATION_FAILED",
        description: "Request validation failed",
        diagnostics: { fields: flattenValidationErrors(errors) },
        humanMessage: "Некорректные параметры запроса.",
      }),
  });
}

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath?: string,
): ValidationFieldDiagnostic[] {
  return errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const current: ValidationFieldDiagnostic[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];

    return [...current, ...flattenValidationErrors(error.children ?? [], field)];
  });
}
