import { BadRequestException } from "@nestjs/common";

import { createValidationPipe } from "../../src/common/validation.pipe";
import {
  PaginationQueryDto,
  normalizePaginationQuery,
} from "../../src/common/query/pagination-query.dto";

describe("PaginationQueryDto", () => {
  const pipe = createValidationPipe();

  it("normalizes defaults for pagination, filter and search", async () => {
    const dto = await pipe.transform(
      { filter: { status: "open" }, q: "support" },
      { type: "query", metatype: PaginationQueryDto },
    );

    expect(normalizePaginationQuery(dto)).toEqual({
      cursor: undefined,
      filter: { status: "open" },
      limit: 50,
      q: "support",
    });
  });

  it("rejects invalid pagination values with the common validation error code", async () => {
    await expect(
      pipe.transform(
        { limit: "500", unexpected: "field" },
        { type: "query", metatype: PaginationQueryDto },
      ),
    ).rejects.toMatchObject<Partial<BadRequestException>>({
      name: "BadRequestException",
    });

    await expect(
      pipe.transform(
        { limit: "500", unexpected: "field" },
        { type: "query", metatype: PaginationQueryDto },
      ),
    ).rejects.toHaveProperty("response.code", "VALIDATION_FAILED");
  });
});
