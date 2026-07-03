import { KB_EMBEDDING_DIMENSIONS } from "../../../packages/contracts/src/c3-kb.mjs";

/**
 * Swappable LLM abstraction for SVC-AI (ТЗ §12.9).
 *
 * A provider exposes two capabilities used by the RAG pipeline:
 *   - embed(text): Promise<number[]>       — a `KB_EMBEDDING_DIMENSIONS`-vector.
 *   - generate({ query, chunks }): Promise<{ text, confidence, citations }>
 *
 * The provider never talks to the database and never performs Knowledge Base
 * search itself — embeddings are handed to Backend (C3.kb) which owns pgvector
 * and tenant isolation. Real providers (OpenAI/YandexGPT/GigaChat/local) can be
 * dropped in behind the same interface without touching the pipeline.
 *
 * In tests we only ever use the deterministic mock below: its embeddings are
 * topic-aware (texts that share vocabulary land close together in L2 space) so
 * ranking assertions are meaningful, and its generation is fully reproducible.
 */

export const LLM_EMBEDDING_DIMENSIONS = KB_EMBEDDING_DIMENSIONS;

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const MIN_TOKEN_LENGTH = 3;
const SEED_SLOTS_PER_TOKEN = 4;

/**
 * Create the deterministic mock LLM provider. No randomness, no network — same
 * input always yields the same embedding and the same generated answer.
 */
export function createDeterministicMockLlm({
  dimensions = LLM_EMBEDDING_DIMENSIONS,
} = {}) {
  return {
    name: "deterministic-mock",
    dimensions,
    available: true,

    async embed(text) {
      return embedText(text, dimensions);
    },

    async generate({ query, chunks = [] }) {
      return generateAnswer({ query, chunks });
    },
  };
}

/**
 * Create a provider that simulates an unreachable LLM. Every capability rejects,
 * which lets the assistant exercise its degradation path (ТЗ §5.4).
 */
export function createUnavailableLlm({
  reason = "unavailable",
  dimensions = LLM_EMBEDDING_DIMENSIONS,
} = {}) {
  const fail = () => {
    throw new LlmUnavailableError(reason);
  };

  return {
    name: "unavailable",
    dimensions,
    available: false,
    async embed() {
      fail();
    },
    async generate() {
      fail();
    },
  };
}

export class LlmUnavailableError extends Error {
  constructor(reason = "unavailable") {
    super(`LLM provider is unavailable: ${reason}`);
    this.name = "LlmUnavailableError";
    this.reason = reason;
  }
}

/**
 * Topic-aware hashed bag-of-words embedding. Each meaningful token is scattered
 * across a few deterministic dimensions; the vector is then L2-normalized. Texts
 * that share vocabulary (e.g. a "возврат" query and a "возврат" chunk) end up
 * close in L2 distance, while unrelated topics stay far apart.
 */
export function embedText(text, dimensions = LLM_EMBEDDING_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    for (let slot = 0; slot < SEED_SLOTS_PER_TOKEN; slot += 1) {
      const hash = hashString(`${token}#${slot}`);
      const index = hash % dimensions;
      const sign = (hash >>> 8) % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
  }

  return normalize(vector);
}

function generateAnswer({ query, chunks }) {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      text:
        "В базе знаний организации не нашлось подходящих материалов по запросу " +
        `«${trimmedQuery}». Ответьте клиенту вручную или уточните вопрос.`,
      confidence: 0.2,
      citations: [],
    };
  }

  const citations = chunks.map((chunk, index) => ({
    index: index + 1,
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    title: chunk.title ?? null,
  }));

  const body = chunks
    .map((chunk, index) => `${summarize(chunk.content)} [${index + 1}]`)
    .join(" ");

  const text =
    `По запросу «${trimmedQuery}» на основе базы знаний организации: ${body}`.trim();

  return {
    text,
    confidence: confidenceFromChunks(chunks),
    citations,
  };
}

function confidenceFromChunks(chunks) {
  const distances = chunks
    .map((chunk) => (typeof chunk.distance === "number" ? chunk.distance : null))
    .filter((distance) => distance !== null);

  if (distances.length === 0) {
    return 0.5;
  }

  const best = Math.min(...distances);
  // L2 distance of unit vectors is in [0, 2]; nearer chunks => higher confidence.
  const confidence = 1 - best / 2;
  return Number(Math.min(0.95, Math.max(0.3, confidence)).toFixed(4));
}

function summarize(content, maxLength = 240) {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function tokenize(text) {
  const normalized = String(text ?? "").toLowerCase();
  const matches = normalized.match(TOKEN_PATTERN);
  if (!matches) {
    return [];
  }
  return matches.filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function normalize(vector) {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }

  if (sumSquares === 0) {
    return vector;
  }

  const magnitude = Math.sqrt(sumSquares);
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function hashString(value) {
  // FNV-1a 32-bit, deterministic across platforms.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
