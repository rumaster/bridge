import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: "Demo Organization" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: "Customer support tenant", nullable: true })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ example: "Europe/Moscow" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ example: "ru-RU" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(16)
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({ enum: ["active", "blocked"], example: "active" })
  @IsIn(["active", "blocked"])
  @IsOptional()
  status?: "active" | "blocked";
}

export class OrganizationResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  id!: string;

  @ApiProperty({ example: "Demo Organization" })
  name!: string;

  @ApiPropertyOptional({ example: "Customer support tenant", nullable: true })
  description!: null | string;

  @ApiProperty({ example: "UTC" })
  timezone!: string;

  @ApiProperty({ example: "ru-RU" })
  locale!: string;

  @ApiProperty({ enum: ["active", "blocked"], example: "active" })
  status!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  updatedAt!: string;
}

export interface OrganizationRow {
  created_at: Date | string;
  description: null | string;
  id: string;
  locale: string;
  name: string;
  status: string;
  timezone: string;
  updated_at: Date | string;
}

export function mapOrganization(row: OrganizationRow): OrganizationResponseDto {
  return {
    createdAt: toIsoString(row.created_at),
    description: row.description,
    id: row.id,
    locale: row.locale,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
