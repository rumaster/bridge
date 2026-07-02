import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export type ErrorDiagnostics = Record<string, unknown>;

export class ApiErrorResponseDto {
  @ApiProperty({ example: "VALIDATION_FAILED" })
  code!: string;

  @ApiProperty({ example: "Request validation failed" })
  description!: string;

  @ApiProperty({ example: "Некорректные параметры запроса." })
  humanMessage!: string;

  @ApiProperty({ example: "91a9aaad-7ef7-4f65-9f6b-71ef7b1c4e61" })
  requestId!: string;

  @ApiPropertyOptional({
    example: { fields: [{ field: "limit", messages: ["limit must not be greater than 100"] }] },
    type: Object,
  })
  diagnostics?: ErrorDiagnostics;
}

export interface ApiErrorBody {
  code: string;
  description: string;
  diagnostics?: ErrorDiagnostics;
  humanMessage: string;
  requestId: string;
}
