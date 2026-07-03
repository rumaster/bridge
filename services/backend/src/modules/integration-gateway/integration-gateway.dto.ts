import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

const CHANNEL_TYPES = ["web_chat", "telegram", "email", "sms", "vk", "max", "whatsapp"] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

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
    additionalProperties: true,
    example: { widget_origin: "https://example.test" },
    type: Object,
  })
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
