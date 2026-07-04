import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import {
  CreateKnowledgeDocumentDto,
  DeleteKnowledgeDocumentResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeDocumentRow,
  ReindexKnowledgeDocumentResponseDto,
  UpdateKnowledgeDocumentDto,
  mapKnowledgeDocument,
} from "./knowledge-base.dto";

@Injectable()
export class KnowledgeBaseService {
  constructor(private readonly database: PgDatabase) {}

  async listDocuments(organizationId: string): Promise<KnowledgeDocumentResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<KnowledgeDocumentRow>(
        `
          SELECT id, organization_id, title, source, status, indexed_at, created_at, updated_at
          FROM knowledge_documents
          WHERE organization_id = $1
          ORDER BY updated_at DESC, id
        `,
        [organizationId],
      );

      return result.rows.map(mapKnowledgeDocument);
    });
  }

  async createDocument(
    organizationId: string,
    payload: CreateKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<KnowledgeDocumentRow>(
        `
          INSERT INTO knowledge_documents (
            id,
            organization_id,
            title,
            source,
            status,
            indexed_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 'indexing', NULL, now(), now())
          RETURNING id, organization_id, title, source, status, indexed_at, created_at, updated_at
        `,
        [randomUUID(), organizationId, payload.title.trim(), normalizeSource(payload.source)],
      );

      return mapKnowledgeDocument(result.rows[0]);
    });
  }

  async updateDocument(
    organizationId: string,
    documentId: string,
    payload: UpdateKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const hasTitle = payload.title !== undefined;
      const hasSource = Object.prototype.hasOwnProperty.call(payload, "source");
      const result = await client.query<KnowledgeDocumentRow>(
        `
          UPDATE knowledge_documents
          SET title = CASE WHEN $3 THEN $4 ELSE title END,
              source = CASE WHEN $5 THEN $6 ELSE source END,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, organization_id, title, source, status, indexed_at, created_at, updated_at
        `,
        [
          organizationId,
          documentId,
          hasTitle,
          payload.title?.trim() ?? null,
          hasSource,
          normalizeSource(payload.source),
        ],
      );

      if (result.rowCount === 0) {
        throw documentNotFound(documentId);
      }

      return mapKnowledgeDocument(result.rows[0]);
    });
  }

  async reindexDocument(
    organizationId: string,
    documentId: string,
  ): Promise<ReindexKnowledgeDocumentResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<Pick<KnowledgeDocumentRow, "id" | "updated_at">>(
        `
          UPDATE knowledge_documents
          SET status = 'indexing',
              indexed_at = NULL,
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, updated_at
        `,
        [organizationId, documentId],
      );

      if (result.rowCount === 0) {
        throw documentNotFound(documentId);
      }

      return {
        accepted: true,
        document_id: result.rows[0].id,
        queued_at: toIso(result.rows[0].updated_at),
        status: "indexing",
      };
    });
  }

  async deleteDocument(
    organizationId: string,
    documentId: string,
  ): Promise<DeleteKnowledgeDocumentResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<{ id: string }>(
        `
          DELETE FROM knowledge_documents
          WHERE organization_id = $1 AND id = $2
          RETURNING id
        `,
        [organizationId, documentId],
      );

      if (result.rowCount === 0) {
        throw documentNotFound(documentId);
      }

      return {
        deleted: true,
        document_id: result.rows[0].id,
      };
    });
  }
}

function normalizeSource(source: string | undefined): null | string {
  const normalized = source?.trim();
  return normalized ? normalized : null;
}

function documentNotFound(documentId: string): NotFoundException {
  return new NotFoundException({
    code: "KNOWLEDGE_DOCUMENT_NOT_FOUND",
    description: `Knowledge document ${documentId} was not found.`,
    humanMessage: "Документ базы знаний не найден.",
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
