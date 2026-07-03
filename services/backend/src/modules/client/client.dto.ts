import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

import { PaginationPageDto } from "../../common/query/paginated-response.dto";

export class CreateClientDto {
  @ApiPropertyOptional({ example: "Jane Customer", nullable: true })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  @IsOptional()
  displayName?: string | null;
}

export class CreateClientNoteDto {
  @ApiProperty({ example: "Asked to be contacted in the evening." })
  @IsString()
  @Matches(/\S/)
  @MaxLength(4000)
  body!: string;
}

export class CreateClientTagDto {
  @ApiProperty({ example: "vip" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  tag!: string;
}

export class AddClientEndpointDto {
  @ApiProperty({ example: "web_chat" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  channel!: string;

  @ApiProperty({ example: "web-chat-session-1" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(256)
  externalId!: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  verified?: boolean;

  @ApiPropertyOptional({ type: Object })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class MergeClientsDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  @IsUUID("4")
  sourceClientId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000302" })
  @IsUUID("4")
  targetClientId!: string;

  @ApiPropertyOptional({ example: "Duplicate external identity" })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

export class ClientResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  organizationId!: string;

  @ApiPropertyOptional({ example: "Jane Customer", nullable: true })
  displayName!: null | string;

  @ApiPropertyOptional({ example: null, nullable: true })
  anonymizedAt!: null | string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  updatedAt!: string;
}

export class ClientListResponseDto {
  @ApiProperty({ type: [ClientResponseDto] })
  items!: ClientResponseDto[];

  @ApiProperty({ type: PaginationPageDto })
  page!: PaginationPageDto;
}

export class ClientNoteResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000311" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  clientId!: string;

  @ApiPropertyOptional({
    example: "00000000-0000-4000-8000-000000000201",
    nullable: true,
  })
  authorUserId!: null | string;

  @ApiProperty({ example: "Asked to be contacted in the evening." })
  body!: string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;
}

export class ClientTagResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000321" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  clientId!: string;

  @ApiProperty({ example: "vip" })
  tag!: string;

  @ApiPropertyOptional({
    example: "00000000-0000-4000-8000-000000000201",
    nullable: true,
  })
  createdBy!: null | string;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;
}

export class ClientEndpointResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  clientId!: string;

  @ApiProperty({ example: "web_chat" })
  channel!: string;

  @ApiProperty({ example: "web-chat-session-1" })
  externalId!: string;

  @ApiProperty({ example: true })
  verified!: boolean;

  @ApiProperty({ type: Object })
  metadata!: Record<string, unknown>;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;
}

export class ClientIdentityLinkResponseDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000701" })
  id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000302" })
  clientId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  endpointId!: string;

  @ApiProperty({ example: "manual" })
  linkType!: string;

  @ApiProperty({ type: Object })
  evidence!: Record<string, unknown>;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  createdAt!: string;

  @ApiPropertyOptional({ example: null, nullable: true, type: String })
  revertedAt!: null | string;
}

export class ClientMergeResponseDto {
  @ApiProperty({ example: true })
  accepted!: boolean;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000301" })
  sourceClientId!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000302" })
  targetClientId!: string;

  @ApiProperty({ example: 1 })
  movedEndpointCount!: number;

  @ApiProperty({ example: 3 })
  movedMessageCount!: number;

  @ApiProperty({ type: [ClientIdentityLinkResponseDto] })
  links!: ClientIdentityLinkResponseDto[];

  @ApiProperty({ example: "core-m2" })
  mode!: string;
}

export interface ClientRow {
  anonymized_at: Date | null | string;
  created_at: Date | string;
  display_name: null | string;
  id: string;
  organization_id: string;
  updated_at: Date | string;
}

export interface ClientNoteRow {
  author_user_id: null | string;
  body: string;
  client_id: string;
  created_at: Date | string;
  id: string;
}

export interface ClientTagRow {
  client_id: string;
  created_at: Date | string;
  created_by: null | string;
  id: string;
  tag: string;
}

export interface ClientEndpointRow {
  channel: string;
  client_id: string;
  created_at: Date | string;
  external_id: string;
  id: string;
  metadata: Record<string, unknown>;
  verified: boolean;
}

export interface ClientIdentityLinkRow {
  client_id: string;
  created_at: Date | string;
  endpoint_id: string;
  evidence: Record<string, unknown>;
  id: string;
  link_type: string;
  reverted_at: Date | null | string;
}

export function mapClient(row: ClientRow): ClientResponseDto {
  return {
    anonymizedAt: nullableIso(row.anonymized_at),
    createdAt: toIso(row.created_at),
    displayName: row.display_name,
    id: row.id,
    organizationId: row.organization_id,
    updatedAt: toIso(row.updated_at),
  };
}

export function mapClientNote(row: ClientNoteRow): ClientNoteResponseDto {
  return {
    authorUserId: row.author_user_id,
    body: row.body,
    clientId: row.client_id,
    createdAt: toIso(row.created_at),
    id: row.id,
  };
}

export function mapClientTag(row: ClientTagRow): ClientTagResponseDto {
  return {
    clientId: row.client_id,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    id: row.id,
    tag: row.tag,
  };
}

export function mapClientEndpoint(row: ClientEndpointRow): ClientEndpointResponseDto {
  return {
    channel: row.channel,
    clientId: row.client_id,
    createdAt: toIso(row.created_at),
    externalId: row.external_id,
    id: row.id,
    metadata: row.metadata,
    verified: row.verified,
  };
}

export function mapClientIdentityLink(row: ClientIdentityLinkRow): ClientIdentityLinkResponseDto {
  return {
    clientId: row.client_id,
    createdAt: toIso(row.created_at),
    endpointId: row.endpoint_id,
    evidence: row.evidence,
    id: row.id,
    linkType: row.link_type,
    revertedAt: nullableIso(row.reverted_at),
  };
}

function nullableIso(value: Date | null | string): null | string {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
