import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export const DEFAULT_CONFIGURATION_KEY = "default";

export class PutConfigurationDto {
  @ApiProperty({ example: { ai: { enabled: true }, locale: "ru-RU" }, type: Object })
  @IsObject()
  value!: Record<string, unknown>;

  @ApiPropertyOptional({ default: DEFAULT_CONFIGURATION_KEY, example: "default" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  @IsOptional()
  key?: string;
}

export class ConfigurationResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: DEFAULT_CONFIGURATION_KEY })
  key!: string;

  @ApiProperty({ example: { ai: { enabled: true } }, type: Object })
  value!: Record<string, unknown>;

  @ApiProperty({ example: 2 })
  version!: number;

  @ApiPropertyOptional({
    example: "00000000-0000-4000-8000-000000000201",
    nullable: true,
  })
  updatedBy!: null | string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z", nullable: true })
  updatedAt!: null | string;
}

export interface ConfigurationRow {
  key: string;
  organization_id: string;
  updated_at: Date | string;
  updated_by: null | string;
  value: Record<string, unknown>;
  version: number;
}

export function mapConfiguration(row: ConfigurationRow): ConfigurationResponseDto {
  return {
    key: row.key,
    organizationId: row.organization_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    updatedBy: row.updated_by,
    value: row.value,
    version: row.version,
  };
}

export function emptyConfiguration(organizationId: string, key: string): ConfigurationResponseDto {
  return {
    key,
    organizationId,
    updatedAt: null,
    updatedBy: null,
    value: {},
    version: 0,
  };
}

export function nextConfigurationVersion(currentVersion: null | number | undefined): number {
  return currentVersion ? currentVersion + 1 : 1;
}
