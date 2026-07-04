import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

export type KnowledgeDocumentStatus = "failed" | "indexed" | "indexing";

export class CreateKnowledgeDocumentDto {
  @ApiPropertyOptional({ example: "30000000-0000-4000-8000-000000000101" })
  @IsUUID("4")
  @IsOptional()
  organization_id?: string;

  @ApiProperty({ example: "FAQ возвратов" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(300)
  title!: string;

  @ApiPropertyOptional({ example: "manual://returns" })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  source?: string;

  @ApiPropertyOptional({ example: "returns.md" })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  file_name?: string;

  @ApiPropertyOptional({ example: "text/markdown" })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  content_type?: string;

  @ApiPropertyOptional({ example: 4096, minimum: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  size_bytes?: number;
}

export class UpdateKnowledgeDocumentDto {
  @ApiPropertyOptional({ example: "FAQ возвратов" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(300)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ example: "manual://returns" })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  source?: string;
}

export class KnowledgeDocumentResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "FAQ возвратов" })
  title!: string;

  @ApiPropertyOptional({ example: "manual://returns", nullable: true })
  source!: null | string;

  @ApiProperty({ enum: ["failed", "indexed", "indexing"], example: "indexed" })
  status!: KnowledgeDocumentStatus;

  @ApiPropertyOptional({ example: "2026-07-04T10:02:00.000Z", nullable: true })
  indexed_at!: null | string;

  @ApiProperty({ example: "2026-07-04T10:01:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-04T10:02:00.000Z" })
  updated_at!: string;
}

export class ReindexKnowledgeDocumentResponseDto {
  @ApiProperty({ example: true })
  accepted!: true;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  document_id!: string;

  @ApiProperty({ example: "indexing" })
  status!: "indexing";

  @ApiProperty({ example: "2026-07-04T10:02:00.000Z" })
  queued_at!: string;
}

export class DeleteKnowledgeDocumentResponseDto {
  @ApiProperty({ example: true })
  deleted!: true;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  document_id!: string;
}

export interface KnowledgeDocumentRow {
  created_at: Date | string;
  id: string;
  indexed_at: Date | null | string;
  organization_id: string;
  source: null | string;
  status: KnowledgeDocumentStatus;
  title: string;
  updated_at: Date | string;
}

export function mapKnowledgeDocument(row: KnowledgeDocumentRow): KnowledgeDocumentResponseDto {
  return {
    created_at: toIso(row.created_at),
    id: row.id,
    indexed_at: nullableIso(row.indexed_at),
    organization_id: row.organization_id,
    source: row.source,
    status: row.status,
    title: row.title,
    updated_at: toIso(row.updated_at),
  };
}

function nullableIso(value: Date | null | string): null | string {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
