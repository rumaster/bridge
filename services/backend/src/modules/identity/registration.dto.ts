import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsString, IsUUID, Matches, MaxLength } from "class-validator";

const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/;
const REGISTRATION_CODE_PATTERN = /^\d{6}$/;

export const REGISTRATION_STATUSES = ["pending", "code_sent", "completed"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export class RegistrationStartDto {
  @ApiProperty({ example: "new_admin" })
  @IsString()
  @Matches(TELEGRAM_USERNAME_PATTERN, {
    message: "telegramUsername must be a valid Telegram username",
  })
  telegramUsername!: string;

  @ApiProperty({ example: "admin@example.com" })
  @IsEmail({}, { message: "email must be a valid email address" })
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: "Acme Support" })
  @IsString()
  @Matches(/\S/, { message: "organizationName must not be blank" })
  @MaxLength(200)
  organizationName!: string;
}

export class RegistrationStartResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  requestId!: string;

  @ApiProperty({ enum: REGISTRATION_STATUSES, example: "pending" })
  status!: RegistrationStatus;

  /**
   * Ссылка, по которой пользователь обязан нажать Start: Telegram Bot API не
   * умеет писать приватному адресату первым, поэтому код уходит только после
   * того, как бот узнает числовой chat_id из апдейта /start.
   */
  @ApiPropertyOptional({
    example: "https://t.me/bridge_auth_bot?start=brr_xxx",
    nullable: true,
    type: String,
  })
  deepLink!: null | string;

  @ApiPropertyOptional({ example: "bridge_auth_bot", nullable: true, type: String })
  botUsername!: null | string;

  @ApiProperty({ example: "2026-07-16T10:00:00.000Z" })
  expiresAt!: string;

  @ApiPropertyOptional({ example: "telegram_bot_not_configured", nullable: true, type: String })
  note?: null | string;
}

export class RegistrationStatusResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  requestId!: string;

  @ApiProperty({ enum: REGISTRATION_STATUSES, example: "code_sent" })
  status!: RegistrationStatus;

  @ApiPropertyOptional({ example: "2026-07-15T10:05:00.000Z", nullable: true, type: String })
  codeExpiresAt!: null | string;

  @ApiProperty({ example: "2026-07-16T10:00:00.000Z" })
  expiresAt!: string;

  @ApiPropertyOptional({ example: "telegram_delivery_failed", nullable: true, type: String })
  note?: null | string;
}

export class RegistrationVerifyDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  @IsUUID("4")
  requestId!: string;

  @ApiProperty({ example: "123456" })
  @IsString()
  @Matches(REGISTRATION_CODE_PATTERN, { message: "code must be a 6 digit number" })
  code!: string;
}

export class RegistrationSessionDto {
  @ApiProperty({ example: true })
  authenticated!: true;

  @ApiProperty({ example: "brs_xxx" })
  token!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: "M1" })
  implementationStage!: string;
}

export function normalizeRegistrationUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function normalizeRegistrationEmail(value: string): string {
  return value.trim().toLowerCase();
}
