import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

export const DEFAULT_CONFIGURATION_KEY = "default";

export interface OrganizationConfigurationValue {
  aiAssistantEnabled: boolean;
  defaultLanguage: string;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
  workflowAutomationEnabled: boolean;
}

export const DEFAULT_ORGANIZATION_CONFIGURATION_VALUE: OrganizationConfigurationValue = {
  aiAssistantEnabled: false,
  defaultLanguage: "ru",
  monthlyMessageLimit: 10000,
  notificationEmail: "",
  retentionDays: 90,
  workflowAutomationEnabled: false,
};

export const ORGANIZATION_CONFIGURATION_FIELDS = [
  "defaultLanguage",
  "aiAssistantEnabled",
  "workflowAutomationEnabled",
  "monthlyMessageLimit",
  "notificationEmail",
  "retentionDays",
] as const satisfies readonly (keyof OrganizationConfigurationValue)[];

export class PutOrganizationConfigurationDto {
  @ApiProperty({ example: "ru" })
  @IsString()
  @Matches(/^[a-z]{2}$/)
  defaultLanguage!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  aiAssistantEnabled!: boolean;

  @ApiProperty({ example: true })
  @IsBoolean()
  workflowAutomationEnabled!: boolean;

  @ApiProperty({ example: 10000 })
  @IsInt()
  @Min(100)
  monthlyMessageLimit!: number;

  @ApiProperty({ example: "admin@example.test" })
  @IsString()
  @MaxLength(320)
  notificationEmail!: string;

  @ApiProperty({ example: 90 })
  @IsInt()
  @Min(1)
  retentionDays!: number;
}

export class OrganizationConfigurationResponseDto extends PutOrganizationConfigurationDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: DEFAULT_CONFIGURATION_KEY })
  key!: string;

  @ApiProperty({ example: 2 })
  version!: number;

  @ApiPropertyOptional({
    example: "00000000-0000-4000-8000-000000000201",
    nullable: true,
    type: String,
  })
  updatedBy!: null | string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z", nullable: true, type: String })
  updatedAt!: null | string;
}

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
    type: String,
  })
  updatedBy!: null | string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z", nullable: true, type: String })
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

export function mapOrganizationConfiguration(
  row: ConfigurationRow,
): OrganizationConfigurationResponseDto {
  return {
    ...normalizeOrganizationConfigurationValue(row.value),
    key: row.key,
    organizationId: row.organization_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    updatedBy: row.updated_by,
    version: row.version,
  };
}

export function emptyOrganizationConfiguration(
  organizationId: string,
): OrganizationConfigurationResponseDto {
  return {
    ...DEFAULT_ORGANIZATION_CONFIGURATION_VALUE,
    key: DEFAULT_CONFIGURATION_KEY,
    organizationId,
    updatedAt: null,
    updatedBy: null,
    version: 0,
  };
}

export function normalizeOrganizationConfigurationValue(
  value: Record<string, unknown> | null | undefined,
): OrganizationConfigurationValue {
  return {
    aiAssistantEnabled: readBoolean(
      value?.aiAssistantEnabled,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.aiAssistantEnabled,
    ),
    defaultLanguage: readString(
      value?.defaultLanguage,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.defaultLanguage,
    ),
    monthlyMessageLimit: readInteger(
      value?.monthlyMessageLimit,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.monthlyMessageLimit,
      100,
    ),
    notificationEmail: readString(
      value?.notificationEmail,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.notificationEmail,
    ),
    retentionDays: readInteger(
      value?.retentionDays,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.retentionDays,
      1,
    ),
    workflowAutomationEnabled: readBoolean(
      value?.workflowAutomationEnabled,
      DEFAULT_ORGANIZATION_CONFIGURATION_VALUE.workflowAutomationEnabled,
    ),
  };
}

export function nextConfigurationVersion(currentVersion: null | number | undefined): number {
  return currentVersion ? currentVersion + 1 : 1;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min: number): number {
  return Number.isInteger(value) && Number(value) >= min ? Number(value) : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
