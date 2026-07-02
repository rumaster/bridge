import { BadRequestException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";

import { ApiExceptionFilter } from "../../src/common/api-exception.filter";

describe("ApiExceptionFilter", () => {
  it("serializes HTTP exceptions to the common error envelope", () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: "req-test-1" }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    const exception = new BadRequestException({
      code: "VALIDATION_FAILED",
      description: "Request validation failed",
      diagnostics: { fields: [{ field: "limit", messages: ["must not exceed 100"] }] },
      humanMessage: "Некорректные параметры запроса.",
    });

    new ApiExceptionFilter().catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      code: "VALIDATION_FAILED",
      description: "Request validation failed",
      diagnostics: { fields: [{ field: "limit", messages: ["must not exceed 100"] }] },
      humanMessage: "Некорректные параметры запроса.",
      requestId: "req-test-1",
    });
  });
});
