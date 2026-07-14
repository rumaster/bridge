import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";

import { PgDatabase } from "../../common/database/database.service";
import {
  CreateKnowledgeDocumentDto,
  DeleteKnowledgeDocumentResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeDocumentRow,
  UpdateKnowledgeDocumentDto,
  mapKnowledgeDocument,
} from "./knowledge-base.dto";
import { KnowledgeEmbeddingService } from "./knowledge-embedding.service";

const DOCUMENT_COLUMNS =
  "id, organization_id, title, content, embedding_sources, created_at, updated_at";

@Injectable()
export class KnowledgeBaseService {
  constructor(
    private readonly database: PgDatabase,
    private readonly embedding: KnowledgeEmbeddingService,
  ) {}

  async listDocuments(organizationId: string): Promise<KnowledgeDocumentResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<KnowledgeDocumentRow>(
        `
          SELECT ${DOCUMENT_COLUMNS}
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
    const title = payload.title.trim();
    const content = payload.content.trim();
    const sources = normalizeSources(payload.embedding_sources);
    // Embed the key phrases before opening the transaction so we never hold a DB
    // txn across a network call to the embedding provider.
    const embeddings = await this.embedding.embedMany(sources);

    return this.database.withTenant(organizationId, async (client) => {
      const documentId = randomUUID();
      const result = await client.query<KnowledgeDocumentRow>(
        `
          INSERT INTO knowledge_documents (
            id, organization_id, title, content, embedding_sources,
            status, indexed_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'indexed', now(), now(), now())
          RETURNING ${DOCUMENT_COLUMNS}
        `,
        [documentId, organizationId, title, content, sources],
      );

      await this.writeEmbeddings(client, organizationId, documentId, content, sources, embeddings);

      return mapKnowledgeDocument(result.rows[0]);
    });
  }

  async updateDocument(
    organizationId: string,
    documentId: string,
    payload: UpdateKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    const nextTitle = payload.title?.trim();
    const nextContent = payload.content?.trim();
    const nextSources =
      payload.embedding_sources === undefined
        ? undefined
        : normalizeSources(payload.embedding_sources);

    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<KnowledgeDocumentRow>(
        `
          UPDATE knowledge_documents
          SET title = CASE WHEN $3 THEN $4 ELSE title END,
              content = CASE WHEN $5 THEN $6 ELSE content END,
              embedding_sources = CASE WHEN $7 THEN $8 ELSE embedding_sources END,
              status = 'indexed',
              indexed_at = now(),
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING ${DOCUMENT_COLUMNS}
        `,
        [
          organizationId,
          documentId,
          nextTitle !== undefined,
          nextTitle ?? null,
          nextContent !== undefined,
          nextContent ?? null,
          nextSources !== undefined,
          nextSources ?? null,
        ],
      );

      if (result.rowCount === 0) {
        throw documentNotFound(documentId);
      }

      const document = result.rows[0];
      const sources = document.embedding_sources ?? [];
      // Chunks carry the phrase embedding *and* the document content, so rewrite
      // them whenever the document changes at all (phrases or content).
      const embeddings = await this.embedding.embedMany(sources);
      await this.writeEmbeddings(
        client,
        organizationId,
        documentId,
        document.content,
        sources,
        embeddings,
      );

      return mapKnowledgeDocument(document);
    });
  }

  async deleteDocument(
    organizationId: string,
    documentId: string,
  ): Promise<DeleteKnowledgeDocumentResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      // knowledge_chunks are removed by the ON DELETE CASCADE foreign key.
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

  /**
   * Replace the document's embeddings: one knowledge_chunks row per key phrase.
   *
   * The row carries the *phrase* embedding (that is what a query is matched
   * against) and the *document* content (that is what C3.kb hands to the
   * assistant as context); the phrase itself is kept in `metadata.source` so a
   * search result can report which phrase matched — same shape as fbp-engine's
   * expertise_document_embeddings.source. A document without phrases keeps no
   * chunks and is therefore never retrieved.
   */
  private async writeEmbeddings(
    client: PoolClient,
    organizationId: string,
    documentId: string,
    content: string,
    sources: string[],
    embeddings: number[][],
  ): Promise<void> {
    await client.query(
      `DELETE FROM knowledge_chunks WHERE organization_id = $1 AND document_id = $2`,
      [organizationId, documentId],
    );

    for (const [index, source] of sources.entries()) {
      await client.query(
        `
          INSERT INTO knowledge_chunks (
            id, organization_id, document_id, chunk_no, content, embedding, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
        `,
        [
          randomUUID(),
          organizationId,
          documentId,
          index + 1,
          content,
          toVectorLiteral(embeddings[index]),
          JSON.stringify({ source }),
        ],
      );
    }
  }
}

/** Trim, drop blanks and de-duplicate while preserving order (mirrors fbp-engine). */
function normalizeSources(sources: string[] | undefined): string[] {
  return Array.from(
    new Set((sources ?? []).map((source) => source.trim()).filter((source) => source.length > 0)),
  );
}

/** pgvector cannot bind arrays natively; pass a `[v1,v2,...]` literal cast with `::vector`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function documentNotFound(documentId: string): NotFoundException {
  return new NotFoundException({
    code: "KNOWLEDGE_DOCUMENT_NOT_FOUND",
    description: `Knowledge document ${documentId} was not found.`,
    humanMessage: "Документ базы знаний не найден.",
  });
}
