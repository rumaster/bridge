import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

const CHANNEL_TYPES = ["web_chat", "telegram", "email", "sms", "vk", "max", "whatsapp"] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Креды одного почтового сервера (IMAP приём либо SMTP отправка), Этап E0. */
export class EmailEndpointCredentialsDto {
  @ApiProperty({ example: "imap.example.com" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @ApiProperty({ example: 993 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @ApiProperty({ example: true, description: "Использовать TLS/SSL при подключении." })
  @IsBoolean()
  tls!: boolean;

  @ApiProperty({ example: "support@example.com" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  username!: string;

  @ApiProperty({
    description:
      "Пароль/секрет почтового сервера. Только в теле запроса: шифруется в " +
      "channels.credentials_envelope и никогда не возвращается в ответе.",
    example: "app-specific-password",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
}

/**
 * Структурные креды email-канала: IMAP (приём) + SMTP (отправка) + адрес
 * отправителя. Сериализуются и шифруются как единый секрет канала (Этап E0
 * плана docs/plan/email-channel-production.md).
 */
export class EmailChannelCredentialsDto {
  @ApiProperty({ type: EmailEndpointCredentialsDto })
  @ValidateNested()
  @Type(() => EmailEndpointCredentialsDto)
  imap!: EmailEndpointCredentialsDto;

  @ApiProperty({ type: EmailEndpointCredentialsDto })
  @ValidateNested()
  @Type(() => EmailEndpointCredentialsDto)
  smtp!: EmailEndpointCredentialsDto;

  @ApiProperty({ example: "support@example.com" })
  @IsEmail()
  @MaxLength(320)
  from_email!: string;

  @ApiPropertyOptional({ example: "Служба поддержки Example" })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  from_name?: string;
}

export class ConnectChannelRequestDto {
  @ApiProperty({ example: "org-1" })
  @IsString()
  @MaxLength(128)
  organization_id!: string;

  @ApiProperty({ enum: CHANNEL_TYPES, example: "telegram" })
  @IsIn(CHANNEL_TYPES)
  channel_type!: ChannelType;

  @ApiProperty({ example: "Основной Web Chat" })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: "secret://telegram/org-1/main" })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  credentials_ref?: string;

  @ApiPropertyOptional({
    description:
      "Plaintext-секрет канала (например токен Telegram-бота из @BotFather). " +
      "Только в теле запроса: шифруется в channels.credentials_envelope и никогда " +
      "не возвращается в ответе. Для Telegram обязателен, формат <bot_id>:<token>.",
    example: "123456789:AA-bot-token-from-botfather",
  })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  credentials?: string;

  @ApiPropertyOptional({
    type: EmailChannelCredentialsDto,
    description:
      "Структурные креды email-канала (IMAP + SMTP). Только для channel_type=email; " +
      "шифруются в channels.credentials_envelope и не возвращаются в ответе.",
  })
  @ValidateNested()
  @Type(() => EmailChannelCredentialsDto)
  @IsOptional()
  email_credentials?: EmailChannelCredentialsDto;

  @ApiPropertyOptional({
    additionalProperties: true,
    example: { widget_origin: "https://example.test" },
    type: Object,
  })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

/**
 * Обновление подключённого канала и ротация его секрета (PUT /v1/channels/:id,
 * Этап E0). Все поля опциональны: передаются только изменяемые. Секрет
 * (`credentials` для токен-каналов либо `email_credentials`) перешифровывается
 * заново; ответ никогда не содержит plaintext-секрета.
 */
export class UpdateChannelRequestDto {
  @ApiPropertyOptional({ example: "Telegram Support" })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description:
      "Новый plaintext-секрет токен-канала (например Telegram-бот). Только в теле " +
      "запроса: перешифровывается и не возвращается в ответе.",
    example: "123456789:AA-new-bot-token",
  })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  credentials?: string;

  @ApiPropertyOptional({
    type: EmailChannelCredentialsDto,
    description: "Новые структурные креды email-канала (IMAP + SMTP).",
  })
  @ValidateNested()
  @Type(() => EmailChannelCredentialsDto)
  @IsOptional()
  email_credentials?: EmailChannelCredentialsDto;

  @ApiPropertyOptional({ additionalProperties: true, type: Object })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

export class ChannelResponseDto {
  @ApiProperty({ example: "web-chat-91a9aaad-7ef7-4f65-9f6b-71ef7b1c4e61" })
  id!: string;

  @ApiProperty({ example: "org-1" })
  organization_id!: string;

  @ApiProperty({ enum: CHANNEL_TYPES, example: "telegram" })
  channel_type!: ChannelType;

  @ApiProperty({ example: "Основной Web Chat" })
  name!: string;

  @ApiProperty({ enum: ["connected", "error", "disabled"], example: "connected" })
  status!: "connected" | "error" | "disabled";

  @ApiPropertyOptional({ example: "secret://telegram/org-1/main" })
  credentials_ref?: string;

  @ApiProperty({ additionalProperties: true, type: Object })
  config!: Record<string, unknown>;

  @ApiPropertyOptional({ example: "2026-07-03T09:00:00.000Z" })
  last_check_at?: string;

  @ApiProperty({ example: "2026-07-03T09:00:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-03T09:00:00.000Z" })
  updated_at!: string;
}

export class ConnectChannelResponseDto {
  @ApiProperty({ type: ChannelResponseDto })
  channel!: ChannelResponseDto;
}

/** Заказ управляемого ящика «Bridge Mail» (Этап M5). */
export class OrderMailboxRequestDto {
  @ApiProperty({ example: "support", description: "Локальная часть адреса (до @)" })
  @IsString()
  @IsNotEmpty()
  local_part!: string;

  @ApiPropertyOptional({ example: "Email support" })
  @IsString()
  @IsOptional()
  name?: string;
}

export class OrderMailboxResponseDto {
  @ApiProperty({ example: "support@mail.example.com" })
  address!: string;

  @ApiProperty({ type: ChannelResponseDto })
  channel!: ChannelResponseDto;
}
