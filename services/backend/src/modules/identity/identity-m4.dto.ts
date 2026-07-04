import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const CONTACT_TYPES = ["email", "telegram"] as const;
const INVITATION_ROLE_CODES = ["administrator", "manager"] as const;
const MAX_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export class ProvisionOrganizationDto {
  @ApiProperty({ example: "Acme Support" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    example: "Customer support tenant",
    nullable: true,
    type: String,
  })
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
}

export class CreateFirstAdministratorInvitationDto {
  @ApiProperty({ enum: CONTACT_TYPES, example: "email" })
  @IsIn(CONTACT_TYPES)
  contactType!: "email" | "telegram";

  @ApiProperty({ example: "admin@example.bridge.local" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(320)
  contactValue!: string;

  @ApiPropertyOptional({ example: "Tenant Admin" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({ example: 604800 })
  @IsInt()
  @Min(1)
  @Max(MAX_INVITATION_TTL_SECONDS)
  @IsOptional()
  expiresInSeconds?: number;
}

export class CreateInvitationDto extends CreateFirstAdministratorInvitationDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  @IsUUID("4")
  organizationId!: string;

  @ApiPropertyOptional({ enum: INVITATION_ROLE_CODES, example: "manager" })
  @IsIn(INVITATION_ROLE_CODES)
  @IsOptional()
  roleCode?: "administrator" | "manager";
}

export class AcceptInvitationDto {
  @ApiProperty({ example: "bri_xxx" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(512)
  token!: string;

  @ApiPropertyOptional({ example: "Invited Manager" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  @IsOptional()
  displayName?: string;
}

export class InvitationResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000231" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ enum: CONTACT_TYPES, example: "email" })
  contactType!: string;

  @ApiProperty({ example: "admin@example.bridge.local" })
  contactValue!: string;

  @ApiProperty({ enum: INVITATION_ROLE_CODES, example: "administrator" })
  roleCode!: string;

  @ApiProperty({ example: "2026-07-10T10:00:00.000Z" })
  expiresAt!: string;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    type: String,
  })
  acceptedAt!: string | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    type: String,
  })
  createdBy!: string | null;

  @ApiProperty({ example: "2026-07-03T10:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "bri_xxx" })
  token!: string;
}

export class InvitationAcceptedSessionDto {
  @ApiProperty({ example: true })
  authenticated!: true;

  @ApiProperty({ example: "brs_xxx" })
  token!: string;

  @ApiProperty({ example: "M4" })
  implementationStage!: "M4";
}

export function normalizeInvitationContact(
  contactType: "email" | "telegram",
  contactValue: string,
): string {
  const value = contactValue.trim();

  if (contactType === "email") {
    if (!isEmailLike(value)) {
      throw new Error("Invitation email contact is invalid.");
    }

    return value.toLowerCase();
  }

  const telegramUsername = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(telegramUsername)) {
    throw new Error("Invitation Telegram contact is invalid.");
  }

  return telegramUsername.toLowerCase();
}

function isEmailLike(value: string): boolean {
  return IsEmailConstraint.test(value) && value.length <= 320;
}

const IsEmailConstraint = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
