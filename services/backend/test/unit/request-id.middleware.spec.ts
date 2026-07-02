import type { NextFunction, Response } from "express";

import {
  REQUEST_ID_HEADER,
  RequestIdMiddleware,
  type RequestWithRequestId,
} from "../../src/common/request-id.middleware";

describe("RequestIdMiddleware", () => {
  it("reuses an incoming request id and mirrors it to the response header", () => {
    const request = {
      headers: { [REQUEST_ID_HEADER]: "incoming-request-id" },
    } as unknown as RequestWithRequestId;
    const response = { setHeader: jest.fn() } as unknown as Response;
    const next: NextFunction = jest.fn();

    new RequestIdMiddleware().use(request, response, next);

    expect(request.requestId).toBe("incoming-request-id");
    expect(response.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, "incoming-request-id");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("generates a request id when the client does not send one", () => {
    const request = { headers: {} } as unknown as RequestWithRequestId;
    const response = { setHeader: jest.fn() } as unknown as Response;
    const next: NextFunction = jest.fn();

    new RequestIdMiddleware().use(request, response, next);

    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, request.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
