import { Injectable, Logger } from "@nestjs/common";

/**
 * Knowledge Base document embedding (redesign).
 *
 * When an administrator saves a Knowledge Base document, its instruction text is
 * embedded here and the vector is stored in `knowledge_chunks` so the existing
 * pgvector RAG retrieval (C3.kb) can find it. This mirrors the tg-games /
 * fbp-engine "Экспертиза" pattern where embeddings are computed inline on save.
 *
 * IMPORTANT — model must match SVC-AI (ai-platform). Document embeddings and the
 * query embeddings produced by ai-platform at search time MUST come from the same
 * model with the same dimension (1536), otherwise the L2/cosine distances are
 * meaningless and retrieval silently returns garbage. Keep the `EMBEDDING_*` /
 * `LLM_EMBEDDING_MODEL_NAME` env in lockstep with ai-platform's provider config.
 * When no provider is configured we fall back to the exact same deterministic
 * embedding ai-platform uses in that case (see services/ai-platform/src/llm.ts).
 */

export const KB_EMBEDDING_DIMENSIONS = 1536;

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const AZURE_DEFAULT_API_VERSION = "2024-10-21";
const REQUEST_TIMEOUT_MS = 15000;

interface EmbeddingProviderConfig {
  endpoint: string;
  headers: Record<string, string>;
  model: string;
}

@Injectable()
export class KnowledgeEmbeddingService {
  private readonly logger = new Logger(KnowledgeEmbeddingService.name);

  /**
   * Embed a single text. Returns a `KB_EMBEDDING_DIMENSIONS` vector.
   */
  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedMany([text]);
    return vector;
  }

  /**
   * Embed a batch of texts (the document's key phrases) in one provider call —
   * mirrors fbp-engine, which embeds the whole `embeddingSources` array at once.
   * Returns one vector per input, in the same order.
   *
   * When a remote provider is configured but fails, the error propagates so the
   * save fails visibly rather than persisting vectors that won't match
   * ai-platform's query embeddings.
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const provider = this.resolveProvider();
    const vectors = provider
      ? await this.remoteEmbed(texts, provider)
      : texts.map((text) => embedTextDeterministic(text, KB_EMBEDDING_DIMENSIONS));

    if (vectors.length !== texts.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${texts.length} inputs.`,
      );
    }
    for (const vector of vectors) {
      if (vector.length !== KB_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding provider returned ${vector.length} dimensions, expected ${KB_EMBEDDING_DIMENSIONS}. ` +
            `Set LLM_EMBEDDING_MODEL_NAME to a 1536-dimension model (e.g. ${DEFAULT_EMBEDDING_MODEL}).`,
        );
      }
    }
    return vectors;
  }

  private resolveProvider(): EmbeddingProviderConfig | null {
    const requested = (process.env.EMBEDDING_PROVIDER ?? process.env.LLM_PROVIDER ?? "")
      .trim()
      .toLowerCase();
    const model = (process.env.LLM_EMBEDDING_MODEL_NAME ?? DEFAULT_EMBEDDING_MODEL).trim();

    const azureKey = process.env.AZURE_OPENAI_API_KEY?.trim();
    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
    const azureDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT?.trim();
    const openAiKey = process.env.OPENAI_API_KEY?.trim();

    if (requested === "azure" && azureKey && azureEndpoint && azureDeployment) {
      const apiVersion = (process.env.AZURE_OPENAI_API_VERSION ?? AZURE_DEFAULT_API_VERSION).trim();
      const base = azureEndpoint.replace(/\/+$/, "");
      return {
        endpoint: `${base}/openai/deployments/${encodeURIComponent(
          azureDeployment,
        )}/embeddings?api-version=${encodeURIComponent(apiVersion)}`,
        headers: { "api-key": azureKey },
        model,
      };
    }

    if (requested !== "azure" && openAiKey) {
      const base = (process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
      return {
        endpoint: `${base}/embeddings`,
        headers: { authorization: `Bearer ${openAiKey}` },
        model,
      };
    }

    // No provider configured — mirror ai-platform's deterministic fallback.
    this.logger.debug(
      "No embedding provider configured; using deterministic embedding (must match ai-platform).",
    );
    return null;
  }

  private async remoteEmbed(
    texts: string[],
    provider: EmbeddingProviderConfig,
  ): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetch(provider.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...provider.headers },
        body: JSON.stringify({ model: provider.model, input: texts }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error("Knowledge embedding request failed", { cause: error });
    }

    if (!response.ok) {
      throw new Error(`Knowledge embedding request returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = body?.data;
    if (!Array.isArray(data)) {
      throw new Error("Knowledge embedding response did not contain vectors");
    }

    // The API may return items out of order — restore the input order via `index`.
    const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    return ordered.map((item) => {
      if (!Array.isArray(item?.embedding)) {
        throw new Error("Knowledge embedding response did not contain a vector");
      }
      return item.embedding;
    });
  }
}

// ── Deterministic fallback (copied verbatim from services/ai-platform/src/llm.ts) ──
// Topic-aware hashed bag-of-words embedding, L2-normalized. Keeping this identical
// to ai-platform guarantees that documents and queries embedded without a provider
// still land in the same vector space.

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const MIN_TOKEN_LENGTH = 3;
const SEED_SLOTS_PER_TOKEN = 4;

export function embedTextDeterministic(text: string, dimensions = KB_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
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

function tokenize(text: string): string[] {
  const normalized = String(text ?? "").toLowerCase();
  const matches = normalized.match(TOKEN_PATTERN);
  if (!matches) {
    return [];
  }
  return matches.filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function normalize(vector: number[]): number[] {
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

function hashString(value: string): number {
  // FNV-1a 32-bit, deterministic across platforms.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
