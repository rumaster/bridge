import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export interface NormalizedPaginationQuery {
  cursor?: string;
  filter?: Record<string, unknown>;
  limit: number;
  q?: string;
}

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 100, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 50;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ description: "Search query", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    additionalProperties: true,
    description: "Structured resource filters",
    type: Object,
  })
  @IsObject()
  @IsOptional()
  filter?: Record<string, unknown>;
}

export function normalizePaginationQuery(dto: PaginationQueryDto): NormalizedPaginationQuery {
  return {
    cursor: dto.cursor,
    filter: dto.filter,
    limit: dto.limit ?? 50,
    q: dto.q,
  };
}
