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

function makeVector(seed: number): number[] {
  const vector = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = seed;
  return vector;
}

function docRow(id: string, title: string, content: string, sources: string[]) {
  return {
    rowCount: 1,
    rows: [
      {
        content,
        created_at: "2026-07-04T10:01:00.000Z",
        embedding_sources: sources,
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
        // params: [id, organizationId, title, content, embedding_sources]
        return docRow(
          params[0] as string,
          params[2] as string,
          params[3] as string,
          params[4] as string[],
        );
      }
      if (text.includes("UPDATE knowledge_documents")) {
        // params: [org, id, hasTitle, title, hasContent, content, hasSources, sources]
        return docRow(
          params[1] as string,
          params[3] as string,
          params[5] as string,
          (params[7] as string[]) ?? [],
        );
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

function chunkInserts(queries: RecordedQuery[]) {
  return queries.filter((q) => q.text.includes("INSERT INTO knowledge_chunks"));
}

describe("KnowledgeBaseService key-phrase embeddings", () => {
  it("embeds each key phrase and writes one knowledge_chunks row per phrase", async () => {
    const queries: RecordedQuery[] = [];
    const embedMany = jest.fn(async (texts: string[]) => texts.map((_, i) => makeVector(i + 1)));
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embedMany,
    } as unknown as KnowledgeEmbeddingService);

    const created = await service.createDocument(ORG_ID, {
      title: "Политика возвратов",
      content: "Возврат в течение 14 дней.",
      embedding_sources: ["возврат товара", "как вернуть покупку"],
    });

    // Embedding is computed from the PHRASES, not from the content.
    expect(embedMany).toHaveBeenCalledWith(["возврат товара", "как вернуть покупку"]);
    expect(created.embedding_sources).toEqual(["возврат товара", "как вернуть покупку"]);

    const chunks = chunkInserts(queries);
    expect(chunks).toHaveLength(2);
    // Each chunk: phrase embedding + document content + metadata.source = phrase.
    expect(chunks[0].params[3]).toBe(1); // chunk_no
    expect(chunks[0].params[4]).toBe("Возврат в течение 14 дней."); // content
    expect(chunks[0].params[5]).toBe(`[${makeVector(1).join(",")}]`);
    expect(JSON.parse(chunks[0].params[6] as string)).toEqual({ source: "возврат товара" });
    expect(chunks[1].params[3]).toBe(2);
    expect(JSON.parse(chunks[1].params[6] as string)).toEqual({ source: "как вернуть покупку" });
  });

  it("trims, drops blanks and de-duplicates phrases while preserving order", async () => {
    const queries: RecordedQuery[] = [];
    const embedMany = jest.fn(async (texts: string[]) => texts.map((_, i) => makeVector(i + 1)));
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embedMany,
    } as unknown as KnowledgeEmbeddingService);

    const created = await service.createDocument(ORG_ID, {
      title: "Доставка",
      content: "Доставка 1-2 дня.",
      embedding_sources: ["  сроки доставки  ", "", "   ", "сроки доставки", "когда привезут"],
    });

    expect(embedMany).toHaveBeenCalledWith(["сроки доставки", "когда привезут"]);
    expect(created.embedding_sources).toEqual(["сроки доставки", "когда привезут"]);
    expect(chunkInserts(queries)).toHaveLength(2);
  });

  it("writes no chunks when the document has no key phrases", async () => {
    const queries: RecordedQuery[] = [];
    const embedMany = jest.fn(async () => []);
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embedMany,
    } as unknown as KnowledgeEmbeddingService);

    await service.createDocument(ORG_ID, {
      title: "Черновик",
      content: "Пока без фраз.",
      embedding_sources: [],
    });

    expect(chunkInserts(queries)).toHaveLength(0);
    // Old chunks are still cleared, so a document can be made unsearchable.
    expect(queries.some((q) => q.text.includes("DELETE FROM knowledge_chunks"))).toBe(true);
  });

  it("re-embeds phrases and rewrites chunks on update", async () => {
    const queries: RecordedQuery[] = [];
    const embedMany = jest.fn(async (texts: string[]) => texts.map((_, i) => makeVector(i + 1)));
    const service = new KnowledgeBaseService(makeDatabase(queries), {
      embedMany,
    } as unknown as KnowledgeEmbeddingService);

    await service.updateDocument(ORG_ID, "doc-1", {
      title: "Политика возвратов v2",
      content: "Возврат в течение 30 дней.",
      embedding_sources: ["возврат 30 дней"],
    });

    expect(embedMany).toHaveBeenCalledWith(["возврат 30 дней"]);
    expect(queries.some((q) => q.text.includes("DELETE FROM knowledge_chunks"))).toBe(true);
    const chunks = chunkInserts(queries);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].params[4]).toBe("Возврат в течение 30 дней.");
    expect(JSON.parse(chunks[0].params[6] as string)).toEqual({ source: "возврат 30 дней" });
  });
});

describe("KnowledgeEmbeddingService deterministic fallback", () => {
  it("returns a deterministic, normalized 1536-vector per input when no provider is configured", async () => {
    const previous = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.LLM_PROVIDER;

    try {
      const service = new KnowledgeEmbeddingService();
      const [first, second] = await service.embedMany(["возврат товара", "сроки доставки"]);
      const [again] = await service.embedMany(["возврат товара"]);

      expect(first).toHaveLength(KB_EMBEDDING_DIMENSIONS);
      expect(second).toHaveLength(KB_EMBEDDING_DIMENSIONS);
      expect(first).toEqual(again);
      expect(first).not.toEqual(second);
      expect(await service.embedMany([])).toEqual([]);

      const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
      expect(magnitude).toBeCloseTo(1, 3);
    } finally {
      process.env = previous;
    }
  });
});
