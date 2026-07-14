import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateOrResumeWebChatSessionDto {
  @ApiProperty({ example: "22345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  organization_id!: string;

  @ApiPropertyOptional({ example: "web-chat-visitor-123" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(256)
  @IsOptional()
  visitor_session_id?: string;

  @ApiPropertyOptional({ example: "32345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  @IsOptional()
  conversation_id?: string;
}

export class WebChatMessagesQueryDto {
  @ApiProperty({ example: "22345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  organization_id!: string;

  @ApiProperty({ example: "web-chat-visitor-123" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(256)
  visitor_session_id!: string;

  @ApiPropertyOptional({ default: 20, maximum: 100, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  cursor?: string;

  // 0 допустим и означает «с начала» (нумерация с 1) — клиент присылал его на
  // догрузке в пустом диалоге; @Min(1) отбивал такой запрос 400-й ошибкой.
  @ApiPropertyOptional({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  after_sequence_number?: number;
}

export class SendWebChatMessageDto {
  @ApiProperty({ example: "22345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  organization_id!: string;

  @ApiProperty({ example: "32345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  conversation_id!: string;

  @ApiProperty({ example: "42345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  endpoint_id!: string;

  @ApiProperty({ example: "52345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  idempotency_key!: string;

  @ApiProperty({ example: "web-chat-visitor-123" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(256)
  visitor_session_id!: string;

  @ApiProperty({ example: { type: "text", text: "Здравствуйте" }, type: Object })
  @IsObject()
  body!: Record<string, unknown>;
}

export class StartWebChatEmailCodeDto {
  @ApiProperty({ example: "22345678-1234-4234-8234-123456789abc" })
  @IsUUID("4")
  organization_id!: string;

  @ApiProperty({ example: "web-chat-visitor-123" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(256)
  visitor_session_id!: string;

  @ApiProperty({ example: "client@example.com" })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class VerifyWebChatEmailCodeDto extends StartWebChatEmailCodeDto {
  @ApiProperty({ example: "123456" })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class WebChatSessionResponseDto {
  @ApiProperty({ example: "web-chat-visitor-123" })
  visitorSessionId!: string;

  @ApiProperty({ example: "22345678-1234-4234-8234-123456789abc" })
  organizationId!: string;

  @ApiProperty({ example: "32345678-1234-4234-8234-123456789abc" })
  conversationId!: string;

  @ApiProperty({ example: "42345678-1234-4234-8234-123456789abc" })
  endpointId!: string;

  @ApiPropertyOptional({ example: "client@example.com" })
  verifiedEmail?: string;
}

export class WebChatEmailCodeStartResponseDto {
  @ApiProperty({ example: true })
  accepted!: boolean;

  @ApiProperty({ example: "62345678-1234-4234-8234-123456789abc" })
  requestId!: string;

  @ApiProperty({ example: "2026-07-07T08:05:00.000Z" })
  expiresAt!: string;

  @ApiPropertyOptional({
    description: "Only returned outside production or when WEB_CHAT_EMAIL_CODE_DEBUG_RESPONSE=1.",
    example: "123456",
  })
  debugCode?: string;
}
