import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";

import type { KnowledgeHit } from "@bridge/contracts/c3-kb-payloads";

import { PgDatabase } from "../../common/database/database.service";
import {
  CreateKnowledgeDocumentDto,
  DeleteKnowledgeDocumentResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeDocumentRow,
  KnowledgeSearchHitDto,
  UpdateKnowledgeDocumentDto,
  mapKnowledgeDocument,
} from "./knowledge-base.dto";
import { KnowledgeEmbeddingService } from "./knowledge-embedding.service";

/** Строка результата pgvector-поиска: чанк плюс поля документа, которые нужны обоим поискам. */
interface ChunkHitRow {
  chunk_id: string;
  chunk_no: number;
  content: string;
  distance: number;
  document_id: string;
  metadata: unknown;
  tags: null | string[];
  title: string;
}

const DOCUMENT_COLUMNS =
  "id, organization_id, title, content, embedding_sources, tags, created_at, updated_at";

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
    const tags = normalizeSources(payload.tags);
    // Embed the key phrases before opening the transaction so we never hold a DB
    // txn across a network call to the embedding provider.
    const embeddings = await this.embedding.embedMany(sources);

    return this.database.withTenant(organizationId, async (client) => {
      const documentId = randomUUID();
      const result = await client.query<KnowledgeDocumentRow>(
        `
          INSERT INTO knowledge_documents (
            id, organization_id, title, content, embedding_sources, tags,
            status, indexed_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'indexed', now(), now(), now())
          RETURNING ${DOCUMENT_COLUMNS}
        `,
        [documentId, organizationId, title, content, sources, tags],
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
    const nextTags = payload.tags === undefined ? undefined : normalizeSources(payload.tags);

    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<KnowledgeDocumentRow>(
        `
          UPDATE knowledge_documents
          SET title = CASE WHEN $3 THEN $4 ELSE title END,
              content = CASE WHEN $5 THEN $6 ELSE content END,
              embedding_sources = CASE WHEN $7 THEN $8 ELSE embedding_sources END,
              tags = CASE WHEN $9 THEN $10 ELSE tags END,
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
          nextTags !== undefined,
          nextTags ?? null,
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
   * Внутренний поиск C3.kb (ТЗ §12.10): SVC-AI считает эмбеддинг запроса сам и
   * присылает его сюда, потому что прямого доступа к БД у него нет — pgvector-поиск
   * под RLS выполняет только Backend, и изоляцию арендатора обеспечивает база, а не
   * договорённость.
   *
   * До 2026-07-15 маршрута `POST /knowledge:search` не существовало вовсе: контракт
   * и клиент были, обработчика не было. RAG-ассистент из-за этого ловил
   * `KbSearchError` и МОЛЧА деградировал до заглушки на каждом запросе — база знаний
   * не читалась никем.
   */
  async searchByEmbedding(
    organizationId: string,
    embedding: number[],
    limit: number,
  ): Promise<KnowledgeHit[]> {
    const rows = await this.queryNearestChunks(organizationId, embedding, limit, null);

    return rows.map((row) => ({
      document_id: row.document_id,
      chunk_id: row.chunk_id,
      chunk_no: row.chunk_no,
      content: row.content,
      distance: row.distance,
      title: row.title,
      metadata: row.metadata,
    }));
  }

  /**
   * Поиск для узла «Поиск в Knowledge Base» (контракт Workflow 2.0).
   *
   * Вход — текстовые ключевые фразы, а не готовый эмбеддинг: LLM-провайдера у движка
   * нет и быть не должно (§13.13-п.3), поэтому вектор считает Backend — той же
   * моделью и размерностью, которой эмбеддит документы при сохранении. Инвариант из
   * CLAUDE.md соблюдается по построению: обе стороны — один сервис.
   *
   * Каждая фраза ищется отдельно, результаты сливаются по документу с сохранением
   * лучшего (минимального) расстояния: документ, близкий сразу к двум фразам, не
   * должен занимать две позиции из top_k.
   */
  async searchByKeys(
    organizationId: string,
    keys: string[],
    tags: string[],
    topK: number,
  ): Promise<KnowledgeSearchHitDto[]> {
    const phrases = normalizeSources(keys);
    if (phrases.length === 0) {
      return [];
    }

    // Пустой список тегов — это «фильтр не задан», а НЕ «найди документы без тегов»:
    // передав сюда [], мы получили бы `d.tags && '{}'` — ложь для любой строки, и
    // поиск без тегов не находил бы ничего.
    const requestedTags = normalizeSources(tags);
    const tagFilter = requestedTags.length > 0 ? requestedTags : null;
    const embeddings = await this.embedding.embedMany(phrases);

    // Каждая фраза берёт top_k своих ближайших: слияние потом отбросит лишние, но
    // урезав раньше, мы бы потеряли документ, который для одной фразы третий, а для
    // другой первый.
    const best = new Map<string, KnowledgeSearchHitDto>();
    for (const vector of embeddings) {
      const rows = await this.queryNearestChunks(organizationId, vector, topK, tagFilter);

      for (const row of rows) {
        const previous = best.get(row.document_id);
        if (previous && previous.distance <= row.distance) {
          continue;
        }
        best.set(row.document_id, {
          document_id: row.document_id,
          title: row.title,
          content: row.content,
          tags: row.tags ?? [],
          // Фраза документа, давшая совпадение: без неё непонятно, почему нашлось.
          matched_key: readSource(row.metadata),
          distance: row.distance,
        });
      }
    }

    return [...best.values()].sort((left, right) => left.distance - right.distance).slice(0, topK);
  }

  /**
   * Ближайшие чанки арендатора. `<->` — L2-расстояние pgvector, то же, что считает
   * эталонная in-memory реализация в SVC-AI.
   *
   * `tagFilter === null` означает «без фильтра» и не равно пустому массиву: пустой
   * список тегов у запроса — это «теги не заданы», а не «найди документы без тегов».
   */
  private async queryNearestChunks(
    organizationId: string,
    embedding: number[],
    limit: number,
    tagFilter: string[] | null,
  ): Promise<ChunkHitRow[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ChunkHitRow>(
        `
          SELECT
            c.document_id,
            c.id AS chunk_id,
            c.chunk_no,
            c.content,
            c.metadata,
            d.title,
            d.tags,
            c.embedding <-> $2::vector AS distance
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND d.organization_id = c.organization_id
          WHERE c.organization_id = $1
            AND ($4::text[] IS NULL OR d.tags && $4::text[])
          ORDER BY distance
          LIMIT $3
        `,
        [organizationId, toVectorLiteral(embedding), limit, tagFilter],
      );

      return result.rows;
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

/** Ключевая фраза, давшая совпадение, лежит в metadata.source (см. writeEmbeddings). */
function readSource(metadata: unknown): string {
  if (metadata !== null && typeof metadata === "object" && "source" in metadata) {
    const source = (metadata as { source?: unknown }).source;
    return typeof source === "string" ? source : "";
  }

  return "";
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
