import { ApiProperty } from "@nestjs/swagger";

import { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export class HealthChecksDto {
  @ApiProperty({ example: "ok" })
  http!: "ok";

  @ApiProperty({ isArray: true, type: FacadeStatusDto })
  facades!: FacadeStatusDto[];
}

export class HealthResponseDto {
  @ApiProperty({ example: "ok" })
  status!: "ok";

  @ApiProperty({ example: "backend" })
  service!: "backend";

  @ApiProperty({ example: "0.0.0" })
  version!: string;

  @ApiProperty({ example: "2026-07-02T16:00:00.000Z" })
  timestamp!: string;

  @ApiProperty({ type: HealthChecksDto })
  checks!: HealthChecksDto;
}
