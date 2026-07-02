import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class PaginationPageDto {
  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiPropertyOptional({ example: "eyJpZCI6IjEyMyJ9" })
  nextCursor?: string;

  @ApiPropertyOptional({ example: 125 })
  total?: number;
}

export class PaginatedResponseDto<TItem> {
  @ApiProperty({ isArray: true })
  items!: TItem[];

  @ApiProperty({ type: PaginationPageDto })
  page!: PaginationPageDto;
}
