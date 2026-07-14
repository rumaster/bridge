import type { PoolClient } from "pg";

import type { PgDatabase } from "../../src/common/database/database.service";
import { KnowledgeBaseService } from "../../src/modules/knowledge-base/knowledge-base.service";
import {
  KB_EMBEDDING_DIMENSIONS,
  KnowledgeEmbeddingService,
} from "../../src/modules/knowledge-base/knowledge-embedding.service";

interface RecordedQuery {
  params: unknown[];
  text: string;
}

const ORG_ID = "30000000-0000-4000-8000-000000000101";

function makeVector(): number[] {
  const vector = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}

function docRow(id: string, title: string, content: string) {
  return {
    rowCount: 1,
    rows: [
      {
        content,
        created_at: "2026-07-04T10:01:00.000Z",
        id,
        organization_id: ORG_ID,
        title,
        updated_at: "2026-07-04T10:02:00.000Z",
      },
    ],
  };
}

function makeDatabase(queries: RecordedQuery[]): PgDatabase {
  const client = {
    async query(text: string, params: unknown[] = []) {
      queries.push({ params, text });
      if (text.includes("INSERT INTO knowledge_documents")) {
        // params: [id, organizationId, title, content]
        return docRow(params[0] as string, params[2] as string, params[3] as string);
      }
      if (text.includes("UPDATE knowledge_documents")) {
        // params: [organizationId, documentId, hasTitle, title, hasContent, content]
        return docRow(params[1] as string, params[3] as string, params[5] as string);
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  return {
    async withTenant<T>(_organizationId: string, callback: (c: PoolClient) => Promise<T>) {
      return callback(client);
    },
  } as unknown as PgDatabase;
}

describe("KnowledgeBaseService embed-on-save", () => {
  it("embeds title+content on create and stores a single knowledge_chunks row", async () => {
    const queries: RecordedQuery[] = [];
    const vector = makeVector();
    const embed = jest.fn(async () => vector);
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embed,
    } as unknown as KnowledgeEmbeddingService);

    const created = await service.createDocument(ORG_ID, {
      title: "Политика возвратов",
      content: "Возврат в течение 14 дней.",
    });

    expect(created).toMatchObject({
      content: "Возврат в течение 14 дней.",
      organization_id: ORG_ID,
      title: "Политика возвратов",
    });
    expect(embed).toHaveBeenCalledWith("Политика возвратов\n\nВозврат в течение 14 дней.");

    const insertDoc = queries.find((q) => q.text.includes("INSERT INTO knowledge_documents"));
    const deleteChunks = queries.find((q) => q.text.includes("DELETE FROM knowledge_chunks"));
    const insertChunk = queries.find((q) => q.text.includes("INSERT INTO knowledge_chunks"));

    expect(insertDoc).toBeDefined();
    expect(deleteChunks).toBeDefined();
    expect(insertChunk).toBeDefined();
    // content is the chunk body; embedding is passed as a pgvector literal.
    expect(insertChunk?.params[3]).toBe("Возврат в течение 14 дней.");
    expect(insertChunk?.params[4]).toBe(`[${vector.join(",")}]`);
  });

  it("re-embeds and rewrites the chunk on update", async () => {
    const queries: RecordedQuery[] = [];
    const embed = jest.fn(async () => makeVector());
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embed,
    } as unknown as KnowledgeEmbeddingService);

    await service.updateDocument(ORG_ID, "doc-1", {
      title: "Политика возвратов v2",
      content: "Возврат в течение 30 дней.",
    });

    expect(embed).toHaveBeenCalledWith("Политика возвратов v2\n\nВозврат в течение 30 дней.");
    expect(queries.some((q) => q.text.includes("DELETE FROM knowledge_chunks"))).toBe(true);
    expect(queries.some((q) => q.text.includes("INSERT INTO knowledge_chunks"))).toBe(true);
  });
});

describe("KnowledgeEmbeddingService deterministic fallback", () => {
  it("returns a deterministic, normalized 1536-vector when no provider is configured", async () => {
    const previous = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.LLM_PROVIDER;

    try {
      const service = new KnowledgeEmbeddingService();
      const first = await service.embed("возврат товара");
      const second = await service.embed("возврат товара");

      expect(first).toHaveLength(KB_EMBEDDING_DIMENSIONS);
      expect(first).toEqual(second);

      const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1, 3);
    } finally {
      process.env = previous;
    }
  });
});
