import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";

const CONTENT_MAX_LENGTH = 20000;

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
  id: string;
  organization_id: string;
  title: string;
  updated_at: Date | string;
}

export function mapKnowledgeDocument(row: KnowledgeDocumentRow): KnowledgeDocumentResponseDto {
  return {
    content: row.content,
    created_at: toIso(row.created_at),
    id: row.id,
    organization_id: row.organization_id,
    title: row.title,
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
