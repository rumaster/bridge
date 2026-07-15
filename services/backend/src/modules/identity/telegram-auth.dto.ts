import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";

const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/;
const LOGIN_CODE_PATTERN = /^\d{4,8}$/;

export class TelegramLoginStartDto {
  @ApiProperty({ example: "seeded_admin" })
  @IsString()
  @Matches(TELEGRAM_USERNAME_PATTERN, {
    message: "telegramUsername must be a valid Telegram username",
  })
  telegramUsername!: string;
}

export class TelegramLoginVerifyDto {
  @ApiProperty({ example: "123456" })
  @IsString()
  @Matches(LOGIN_CODE_PATTERN, { message: "code must be a 4-8 digit number" })
  code!: string;

  @ApiPropertyOptional({ example: "00000000-0000-4000-8000-000000000401" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  @IsOptional()
  requestId?: string;

  @ApiPropertyOptional({ example: "seeded_admin" })
  @IsString()
  @Matches(TELEGRAM_USERNAME_PATTERN, {
    message: "telegramUsername must be a valid Telegram username",
  })
  @IsOptional()
  telegramUsername?: string;

  /**
   * Обязателен, только если один Telegram-аккаунт — администратор нескольких
   * организаций. В этом случае verify отвечает 409 со списком организаций, и
   * клиент повторяет запрос с выбранной.
   */
  @ApiPropertyOptional({ example: "00000000-0000-4000-8000-000000000101" })
  @IsUUID("4")
  @IsOptional()
  organizationId?: string;
}

export class TelegramLoginOrganizationChoiceDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  id!: string;

  @ApiProperty({ example: "Acme Support" })
  name!: string;

  @ApiProperty({ example: "administrator" })
  role!: string;
}

export class TelegramLoginStartResponseDto {
  @ApiProperty({ example: "code_delivery_scheduled" })
  status!: string;

  @ApiProperty({ example: "telegram" })
  delivery!: "telegram";

  @ApiProperty({ example: "telegram" })
  deliveryChannel!: "telegram";

  @ApiProperty({ example: "seeded_admin" })
  telegramUsername!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  requestId!: string;

  @ApiProperty({ example: "2026-07-04T10:05:00.000Z" })
  expiresAt!: string;

  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;

  @ApiProperty({ example: "M1" })
  implementationStage!: string;

  @ApiPropertyOptional({ example: "telegram_bot_not_configured", nullable: true, type: String })
  note?: string | null;
}

export class TelegramLoginSessionDto {
  @ApiProperty({ example: true })
  authenticated!: true;

  @ApiProperty({ example: "brs_xxx" })
  token!: string;

  @ApiProperty({ example: "M1" })
  implementationStage!: string;
}

export function normalizeTelegramUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}
