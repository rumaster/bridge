import type { PoolClient } from "pg";

import type { PgDatabase } from "../../src/common/database/database.service";
import { KnowledgeBaseService } from "../../src/modules/knowledge-base/knowledge-base.service";
import {
  KB_EMBEDDING_DIMENSIONS,
  KnowledgeEmbeddingService,
} from "../../src/modules/knowledge-base/knowledge-embedding.service";

/**
 * Поиск по базе знаний: внутренний C3.kb (вход — готовый эмбеддинг от SVC-AI) и
 * поиск узла «Поиск в Knowledge Base» (вход — текстовые ключевые фразы).
 *
 * Маршрута `POST /knowledge:search` не существовало вовсе, из-за чего RAG-ассистент
 * молча деградировал на каждом запросе. Поэтому проверяется не только «находит», но
 * и форма ответа, и — отдельно — фильтр тегов: пустой список тегов ОБЯЗАН означать
 * «фильтр не задан», а не «документы без тегов».
 */

const ORG_ID = "30000000-0000-4000-8000-000000000101";
const RETURNS_DOC = "40000000-0000-4000-8000-000000000701";
const HOURS_DOC = "40000000-0000-4000-8000-000000000702";

function makeVector(seed: number): number[] {
  const vector = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = seed;
  return vector;
}

interface ChunkFixture {
  chunk_id: string;
  chunk_no: number;
  content: string;
  distance: number;
  document_id: string;
  metadata: unknown;
  tags: string[];
  title: string;
}

function chunk(overrides: Partial<ChunkFixture> = {}): ChunkFixture {
  return {
    chunk_id: "50000000-0000-4000-8000-000000000001",
    chunk_no: 1,
    content: "Возврат товара возможен в течение 14 дней.",
    distance: 0.1,
    document_id: RETURNS_DOC,
    metadata: { source: "как вернуть покупку" },
    tags: ["возвраты"],
    title: "Политика возвратов",
    ...overrides,
  };
}

interface SearchCall {
  limit: unknown;
  tagFilter: unknown;
  vector: unknown;
}

/**
 * Фейк базы: отдаёт заранее заданные наборы чанков по одному на каждый вызов поиска
 * (по одному вызову на ключевую фразу) и записывает переданные параметры — именно в
 * них живёт разница между «фильтра нет» и «фильтр пустой».
 */
function makeDatabase(responses: ChunkFixture[][], calls: SearchCall[]): PgDatabase {
  let index = 0;

  const client = {
    async query(text: string, params: unknown[] = []) {
      if (!text.includes("FROM knowledge_chunks")) {
        return { rowCount: 0, rows: [] };
      }
      calls.push({ limit: params[2], tagFilter: params[3], vector: params[1] });
      const rows = responses[index] ?? [];
      index += 1;
      return { rowCount: rows.length, rows };
    },
  } as unknown as PoolClient;

  return {
    async withTenant<T>(_organizationId: string, callback: (c: PoolClient) => Promise<T>) {
      return callback(client);
    },
  } as unknown as PgDatabase;
}

function makeService(responses: ChunkFixture[][], calls: SearchCall[]) {
  const embedMany = jest.fn(async (texts: string[]) => texts.map((_, i) => makeVector(i + 1)));
  const service = new KnowledgeBaseService(makeDatabase(responses, calls), {
    embedMany,
  } as unknown as KnowledgeEmbeddingService);

  return { embedMany, service };
}

describe("KnowledgeBaseService.searchByKeys — поиск узла схемы", () => {
  it("считает эмбеддинг по каждой ключевой фразе и ищет по каждой отдельно", async () => {
    // Вектор считает Backend, а не движок: LLM-провайдера у движка нет (§13.13-п.3).
    const calls: SearchCall[] = [];
    const { embedMany, service } = makeService(
      [[chunk()], [chunk({ chunk_no: 2, distance: 0.3, metadata: { source: "возврат товара" } })]],
      calls,
    );

    await service.searchByKeys(ORG_ID, ["как вернуть покупку", "возврат товара"], [], 5);

    expect(embedMany).toHaveBeenCalledWith(["как вернуть покупку", "возврат товара"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].vector).toBe(`[${makeVector(1).join(",")}]`);
    expect(calls[1].vector).toBe(`[${makeVector(2).join(",")}]`);
  });

  it("пустой список тегов означает «фильтр не задан», а не «документы без тегов»", async () => {
    // Регрессия: при передаче [] условие вырождалось в `d.tags && '{}'` — ложь для
    // любой строки, и поиск без тегов не находил НИЧЕГО. Поймано пробником на живой
    // базе, юнит-тестами на выдачу — нет.
    const calls: SearchCall[] = [];
    const { service } = makeService([[chunk()]], calls);

    const found = await service.searchByKeys(ORG_ID, ["как вернуть покупку"], [], 5);

    expect(calls[0].tagFilter).toBeNull();
    expect(found).toHaveLength(1);
  });

  it("передаёт заданные теги в фильтр, отбрасывая пустые", async () => {
    const calls: SearchCall[] = [];
    const { service } = makeService([[chunk()]], calls);

    await service.searchByKeys(ORG_ID, ["как вернуть покупку"], ["возвраты", "  ", "возвраты"], 5);

    expect(calls[0].tagFilter).toEqual(["возвраты"]);
  });

  it("сливает документ, найденный по нескольким фразам, оставляя лучшее расстояние", async () => {
    // Иначе документ, близкий сразу к двум фразам, занял бы две позиции из top_k.
    const calls: SearchCall[] = [];
    const { service } = makeService(
      [
        [chunk({ distance: 0.7, metadata: { source: "как вернуть покупку" } })],
        [chunk({ chunk_no: 2, distance: 0.2, metadata: { source: "возврат товара" } })],
      ],
      calls,
    );

    const found = await service.searchByKeys(ORG_ID, ["как вернуть покупку", "возврат товара"], [], 5);

    expect(found).toHaveLength(1);
    expect(found[0].distance).toBe(0.2);
    // matched_key объясняет, ПОЧЕМУ документ нашёлся, — и это фраза лучшего попадания.
    expect(found[0].matched_key).toBe("возврат товара");
  });

  it("сортирует выдачу по возрастанию расстояния и режет по top_k", async () => {
    const calls: SearchCall[] = [];
    const { service } = makeService(
      [
        [
          chunk({ distance: 0.9 }),
          chunk({
            distance: 0.1,
            document_id: HOURS_DOC,
            metadata: { source: "когда вы работаете" },
            tags: ["режим"],
            title: "График работы",
          }),
        ],
      ],
      calls,
    );

    const found = await service.searchByKeys(ORG_ID, ["что-нибудь"], [], 1);

    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("График работы");
  });

  it("без ключевых фраз не ходит в базу и возвращает пусто", async () => {
    // Пустой запрос иначе притащил бы произвольные top_k документов.
    const calls: SearchCall[] = [];
    const { embedMany, service } = makeService([[chunk()]], calls);

    const found = await service.searchByKeys(ORG_ID, ["", "   "], [], 5);

    expect(found).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("KnowledgeBaseService.searchByEmbedding — внутренний C3.kb", () => {
  it("ищет по готовому вектору SVC-AI и возвращает поля, которых ждёт контракт", async () => {
    // SVC-AI проверяет ответ по C3_KB_SEARCH_RESPONSE_SCHEMA: нехватка поля — это не
    // ошибка, а тихая деградация ассистента до заглушки.
    const calls: SearchCall[] = [];
    const { embedMany, service } = makeService([[chunk()]], calls);

    const hits = await service.searchByEmbedding(ORG_ID, makeVector(7), 3);

    // Вектор пришёл снаружи — Backend его не пересчитывает.
    expect(embedMany).not.toHaveBeenCalled();
    expect(calls[0].vector).toBe(`[${makeVector(7).join(",")}]`);
    expect(calls[0].limit).toBe(3);
    // Внутренний поиск тегами не фильтрует: у контракта C3.kb их нет.
    expect(calls[0].tagFilter).toBeNull();
    expect(hits).toEqual([
      {
        document_id: RETURNS_DOC,
        chunk_id: "50000000-0000-4000-8000-000000000001",
        chunk_no: 1,
        content: "Возврат товара возможен в течение 14 дней.",
        distance: 0.1,
        title: "Политика возвратов",
        metadata: { source: "как вернуть покупку" },
      },
    ]);
  });
});
