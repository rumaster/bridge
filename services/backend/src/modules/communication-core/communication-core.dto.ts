import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

import { PaginationPageDto } from "../../common/query/paginated-response.dto";

export class CreateMessageDto {
  @ApiPropertyOptional({ example: "00000000-0000-4000-8000-000000000601" })
  @IsUUID("4")
  @IsOptional()
  id?: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  @IsUUID("4")
  conversationId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  @IsUUID("4")
  endpointId!: string;

  @ApiPropertyOptional({ example: "web_chat" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  @IsOptional()
  channel?: string;

  @ApiPropertyOptional({ enum: ["inbound", "outbound"], example: "outbound" })
  @IsIn(["inbound", "outbound"])
  @IsOptional()
  direction?: "inbound" | "outbound";

  @ApiPropertyOptional({
    enum: ["client", "manager", "ai", "broadcast", "system"],
    example: "manager",
  })
  @IsIn(["client", "manager", "ai", "broadcast", "system"])
  @IsOptional()
  senderType?: "ai" | "broadcast" | "client" | "manager" | "system";

  @ApiPropertyOptional({ minimum: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  sequenceNumber?: number;

  @ApiPropertyOptional({ example: "text" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  @IsOptional()
  type?: string;

  @ApiProperty({ example: { text: "Hello" }, type: Object })
  @IsObject()
  content!: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: ["received", "routed", "sent", "delivered", "failed"],
    example: "routed",
  })
  @IsIn(["received", "routed", "sent", "delivered", "failed"])
  @IsOptional()
  status?: "delivered" | "failed" | "received" | "routed" | "sent";
}

export class ConversationResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  clientId!: string;

  @ApiProperty({ enum: ["open", "closed", "pending"], example: "open" })
  status!: string;

  @ApiPropertyOptional({ example: "2026-01-01T00:00:00.000Z", nullable: true })
  lastMessageAt!: null | string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  updatedAt!: string;
}

export class ConversationListResponseDto {
  @ApiProperty({ type: [ConversationResponseDto] })
  items!: ConversationResponseDto[];

  @ApiProperty({ type: PaginationPageDto })
  page!: PaginationPageDto;
}

export class MessageResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000601" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000501" })
  conversationId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  endpointId!: string;

  @ApiProperty({ example: "web_chat" })
  channel!: string;

  @ApiProperty({ enum: ["inbound", "outbound"], example: "outbound" })
  direction!: string;

  @ApiProperty({ enum: ["client", "manager", "ai", "broadcast", "system"], example: "manager" })
  senderType!: string;

  @ApiProperty({ example: 2 })
  sequenceNumber!: number;

  @ApiProperty({ example: "text" })
  type!: string;

  @ApiProperty({ example: { text: "Hello" }, type: Object })
  content!: Record<string, unknown>;

  @ApiProperty({ enum: ["received", "routed", "sent", "delivered", "failed"], example: "routed" })
  status!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  deliveredAt!: null | string;
}

export class MessageListResponseDto {
  @ApiProperty({ type: [MessageResponseDto] })
  items!: MessageResponseDto[];

  @ApiProperty({ type: PaginationPageDto })
  page!: PaginationPageDto;
}

export interface ConversationRow {
  client_id: string;
  created_at: Date | string;
  id: string;
  last_message_at: Date | null | string;
  organization_id: string;
  status: string;
  updated_at: Date | string;
}

export interface MessageRow {
  channel: string;
  content: Record<string, unknown>;
  conversation_id: string;
  created_at: Date | string;
  delivered_at: Date | null | string;
  direction: string;
  endpoint_id: string;
  id: string;
  organization_id: string;
  sender_type: string;
  sequence_number: number;
  status: string;
  type: string;
}

export function mapConversation(row: ConversationRow): ConversationResponseDto {
  return {
    clientId: row.client_id,
    createdAt: toIso(row.created_at),
    id: row.id,
    lastMessageAt: nullableIso(row.last_message_at),
    organizationId: row.organization_id,
    status: row.status,
    updatedAt: toIso(row.updated_at),
  };
}

export function mapMessage(row: MessageRow): MessageResponseDto {
  return {
    channel: row.channel,
    content: row.content,
    conversationId: row.conversation_id,
    createdAt: toIso(row.created_at),
    deliveredAt: nullableIso(row.delivered_at),
    direction: row.direction,
    endpointId: row.endpoint_id,
    id: row.id,
    organizationId: row.organization_id,
    senderType: row.sender_type,
    sequenceNumber: Number(row.sequence_number),
    status: row.status,
    type: row.type,
  };
}

function nullableIso(value: Date | null | string): null | string {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
