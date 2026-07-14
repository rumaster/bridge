import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

const CONTENT_MAX_LENGTH = 20000;
const SOURCE_MAX_LENGTH = 500;
const SOURCES_MAX_SIZE = 50;

/**
 * Ключевые (поисковые) фразы документа. Эмбеддинг считается по каждой фразе, а не
 * по контенту: фраза описывает, на какие запросы документ должен находиться.
 * Пустой список допустим — тогда документ сохраняется, но не участвует в поиске
 * (поведение образца — «Экспертиза» в rumaster/fbp-engine).
 */
const SOURCES_EXAMPLE = ["возврат товара", "как вернуть покупку", "деньги за возврат"];

export class CreateKnowledgeDocumentDto {
  @ApiPropertyOptional({ example: "30000000-0000-4000-8000-000000000101" })
  @IsUUID("4")
  @IsOptional()
  organization_id?: string;

  @ApiProperty({ example: "Политика возвратов" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(300)
  title!: string;

  @ApiProperty({
    example:
      "Возврат товара возможен в течение 14 дней при сохранении товарного вида. Деньги возвращаются на карту в течение 5 рабочих дней.",
  })
  @IsString()
  @Matches(/\S/)
  @MaxLength(CONTENT_MAX_LENGTH)
  content!: string;

  @ApiPropertyOptional({ type: [String], example: SOURCES_EXAMPLE })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(SOURCE_MAX_LENGTH, { each: true })
  @ArrayMaxSize(SOURCES_MAX_SIZE)
  @IsOptional()
  embedding_sources?: string[];
}

export class UpdateKnowledgeDocumentDto {
  @ApiPropertyOptional({ example: "Политика возвратов" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(300)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ example: "Обновлённая инструкция для ассистента." })
  @IsString()
  @Matches(/\S/)
  @MaxLength(CONTENT_MAX_LENGTH)
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ type: [String], example: SOURCES_EXAMPLE })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(SOURCE_MAX_LENGTH, { each: true })
  @ArrayMaxSize(SOURCES_MAX_SIZE)
  @IsOptional()
  embedding_sources?: string[];
}

export class KnowledgeDocumentResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "Политика возвратов" })
  title!: string;

  @ApiProperty({ example: "Возврат товара возможен в течение 14 дней..." })
  content!: string;

  @ApiProperty({ type: [String], example: SOURCES_EXAMPLE })
  embedding_sources!: string[];

  @ApiProperty({ example: "2026-07-04T10:01:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-04T10:02:00.000Z" })
  updated_at!: string;
}

export class DeleteKnowledgeDocumentResponseDto {
  @ApiProperty({ example: true })
  deleted!: true;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  document_id!: string;
}

export interface KnowledgeDocumentRow {
  content: string;
  created_at: Date | string;
  embedding_sources: null | string[];
  id: string;
  organization_id: string;
  title: string;
  updated_at: Date | string;
}

export function mapKnowledgeDocument(row: KnowledgeDocumentRow): KnowledgeDocumentResponseDto {
  return {
    content: row.content,
    created_at: toIso(row.created_at),
    embedding_sources: row.embedding_sources ?? [],
    id: row.id,
    organization_id: row.organization_id,
    title: row.title,
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
