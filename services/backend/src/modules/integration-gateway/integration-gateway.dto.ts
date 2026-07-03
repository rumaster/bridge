import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class ConnectChannelRequestDto {
  @ApiProperty({ example: "org-1" })
  @IsString()
  @MaxLength(128)
  organization_id!: string;

  @ApiProperty({ enum: ["web_chat"], example: "web_chat" })
  @IsIn(["web_chat"])
  channel_type!: "web_chat";

  @ApiProperty({ example: "Основной Web Chat" })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: "secret://web-chat/org-1/main" })
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

  @ApiProperty({ enum: ["web_chat"], example: "web_chat" })
  channel_type!: "web_chat";

  @ApiProperty({ example: "Основной Web Chat" })
  name!: string;

  @ApiProperty({ enum: ["connected", "error", "disabled"], example: "connected" })
  status!: "connected" | "error" | "disabled";

  @ApiPropertyOptional({ example: "secret://web-chat/org-1/main" })
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
