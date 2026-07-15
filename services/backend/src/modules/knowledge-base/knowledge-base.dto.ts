import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const CONTENT_MAX_LENGTH = 20000;
const SOURCE_MAX_LENGTH = 500;
const SOURCES_MAX_SIZE = 50;
const TAG_MAX_LENGTH = 100;
const TAGS_MAX_SIZE = 30;

/**
 * Ключевые (поисковые) фразы документа. Эмбеддинг считается по каждой фразе, а не
 * по контенту: фраза описывает, на какие запросы документ должен находиться.
 * Пустой список допустим — тогда документ сохраняется, но не участвует в поиске
 * (поведение образца — «Экспертиза» в rumaster/fbp-engine).
 */
const SOURCES_EXAMPLE = ["возврат товара", "как вернуть покупку", "деньги за возврат"];

/**
 * Теги-предфильтр (добавлены 2026-07-15 под узел «Поиск в Knowledge Base»).
 * В эмбеддинге НЕ участвуют: тег сужает множество документов ДО векторного поиска,
 * а не влияет на расстояния внутри него.
 */
const TAGS_EXAMPLE = ["продажи", "возвраты"];

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

  @ApiPropertyOptional({ type: [String], example: TAGS_EXAMPLE })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsOptional()
  tags?: string[];
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

  @ApiPropertyOptional({ type: [String], example: TAGS_EXAMPLE })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsOptional()
  tags?: string[];
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

  @ApiProperty({ type: [String], example: TAGS_EXAMPLE })
  tags!: string[];

  @ApiProperty({ example: "2026-07-04T10:01:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-04T10:02:00.000Z" })
  updated_at!: string;
}

/**
 * Запрос узла «Поиск в Knowledge Base» (контракт Workflow 2.0).
 *
 * Отличается от внутреннего C3.kb-поиска входом: SVC-AI присылает уже посчитанный
 * эмбеддинг, а узел схемы — текстовые ключевые фразы, потому что LLM-провайдера у
 * движка нет и быть не должно (ТЗ §13.13-п.3). Эмбеддинг фраз считает Backend той
 * же моделью, которой эмбеддит документы, — иначе расстояния несопоставимы.
 */
export class SearchKnowledgeDocumentsDto {
  @ApiProperty({ type: [String], example: ["как вернуть покупку"] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(SOURCE_MAX_LENGTH, { each: true })
  @ArrayMaxSize(SOURCES_MAX_SIZE)
  keys!: string[];

  @ApiPropertyOptional({ type: [String], example: TAGS_EXAMPLE })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  top_k?: number;
}

/** Один найденный документ: контент уходит в промпт, `matched_key` объясняет, почему нашёлся. */
export class KnowledgeSearchHitDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000701" })
  document_id!: string;

  @ApiProperty({ example: "Политика возвратов" })
  title!: string;

  @ApiProperty({ example: "Возврат товара возможен в течение 14 дней..." })
  content!: string;

  @ApiProperty({ type: [String], example: TAGS_EXAMPLE })
  tags!: string[];

  @ApiProperty({ example: "как вернуть покупку", description: "Ключевая фраза документа, давшая совпадение." })
  matched_key!: string;

  @ApiProperty({ example: 0.1234, description: "L2-расстояние: меньше — ближе." })
  distance!: number;
}

export class KnowledgeSearchResponseDto {
  @ApiProperty({ type: [KnowledgeSearchHitDto] })
  documents!: KnowledgeSearchHitDto[];
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
  tags: null | string[];
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
    tags: row.tags ?? [],
    title: row.title,
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
