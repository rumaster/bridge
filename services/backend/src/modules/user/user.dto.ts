import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const USER_STATUSES = ["active", "blocked"] as const;

export class CreateUserDto {
  @ApiProperty({ example: "Manager User" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  displayName!: string;

  @ApiPropertyOptional({ example: "manager@example.bridge.local" })
  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: "manager_user" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  @IsOptional()
  telegramUsername?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES, example: "active" })
  @IsIn(USER_STATUSES)
  @IsOptional()
  status?: "active" | "blocked";

  @ApiPropertyOptional({ example: ["manager"], isArray: true })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  roleCodes?: string[];
}

export class PatchUserDto {
  @ApiPropertyOptional({ example: "Manager User" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({ example: "manager@example.bridge.local" })
  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ example: "manager_user" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  @IsOptional()
  telegramUsername?: string | null;

  @ApiPropertyOptional({ enum: USER_STATUSES, example: "blocked" })
  @IsIn(USER_STATUSES)
  @IsOptional()
  status?: "active" | "blocked";

  @ApiPropertyOptional({ example: ["administrator", "manager"], isArray: true })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  roleCodes?: string[];
}

export class UserResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000201" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiPropertyOptional({ example: "seeded_admin", nullable: true })
  telegramUsername!: null | string;

  @ApiPropertyOptional({ example: "seeded-admin@example.bridge.local", nullable: true })
  email!: null | string;

  @ApiProperty({ example: "Seeded Admin" })
  displayName!: string;

  @ApiProperty({ enum: USER_STATUSES, example: "active" })
  status!: string;

  @ApiProperty({ example: ["administrator"], isArray: true })
  roleCodes!: string[];

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  updatedAt!: string;
}

export class UserListResponseDto {
  @ApiProperty({ type: [UserResponseDto] })
  items!: UserResponseDto[];
}

export class RevokeUserSessionsResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000201" })
  userId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: 2 })
  revokedCount!: number;
}

export interface UserRow {
  created_at: Date | string;
  display_name: string;
  email: null | string;
  id: string;
  organization_id: string;
  role_codes: null | string[];
  status: string;
  telegram_username: null | string;
  updated_at: Date | string;
}

export function mapUser(row: UserRow): UserResponseDto {
  return {
    createdAt: toIso(row.created_at),
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    organizationId: row.organization_id,
    roleCodes: row.role_codes ?? [],
    status: row.status,
    telegramUsername: row.telegram_username,
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
