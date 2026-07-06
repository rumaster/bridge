import {
  createKnowledgeSearchRequest,
  validateKnowledgeSearchResponse,
} from "../../../packages/contracts/src/c3-kb.js";
import type { LlmProvider } from "./llm.js";

/**
 * Knowledge Base search (C3.kb) — SVC-AI reaches the KB ONLY through Backend
 * (ТЗ §12.10, §22.6): SVC-AI computes the query embedding and asks Backend to run
 * the pgvector search under Row Level Security, so tenant isolation is enforced by
 * the database and no cross-tenant chunk ever reaches the prompt. This module has
 * no direct database access.
 */

/** Knowledge Base search surface (C3.kb) consumed by the RAG assistant. */
export interface KbSearch {
  search(args: any): Promise<{ results: any }>;
  ensureEmbeddings?(): Promise<void>;
}

/** Options accepted by {@link createInMemoryKbSearch}. */
export interface InMemoryKbSearchOptions {
  chunks?: any[];
  llm?: LlmProvider;
}

export class KbSearchError extends Error {
  constructor(message: string, { cause }: { cause?: unknown } = {}) {
    super(message);
    this.name = "KbSearchError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Production Knowledge Base search: an HTTP client to Backend's
 * `POST /knowledge:search` (C3.kb). Any transport/protocol failure surfaces as a
 * KbSearchError so the assistant can degrade gracefully.
 */
export function createBackendKbSearch({
  baseUrl,
  fetchImpl = globalThis.fetch,
  path = "/knowledge:search",
  timeoutMs = 5000,
}): KbSearch {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("createBackendKbSearch requires baseUrl");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createBackendKbSearch requires a fetch implementation");
  }

  const endpoint = new URL(path, baseUrl).toString();

  return {
    async search({ organizationId, embedding, query, limit }) {
      const request = createKnowledgeSearchRequest({
        organizationId,
        embedding,
        query,
        limit,
      });

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new KbSearchError("Knowledge Base search request failed", {
          cause: error,
        });
      }

      if (!response.ok) {
        throw new KbSearchError(
          `Knowledge Base search returned HTTP ${response.status}`,
        );
      }

      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new KbSearchError("Knowledge Base search returned invalid JSON", {
          cause: error,
        });
      }

      const validation = validateKnowledgeSearchResponse(body);
      if (!validation.valid) {
        throw new KbSearchError(
          `Knowledge Base search response is not a valid C3.kb payload: ${validation.errors.join("; ")}`,
        );
      }

      assertTenantIsolation(body, organizationId);
      return { results: body.results };
    },
  };
}

/**
 * In-memory Knowledge Base search that mirrors Backend's pgvector behaviour
 * (filter by organization_id, order by ascending L2 distance, apply the limit).
 * Used by service-level integration/e2e tests and as a local reference; it never
 * returns a chunk from another organization.
 */
export function createInMemoryKbSearch({ chunks = [], llm }: InMemoryKbSearchOptions = {}): KbSearch {
  const indexed = chunks.map((chunk) => ({
    organization_id: chunk.organization_id,
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id ?? chunk.id,
    chunk_no: chunk.chunk_no ?? 1,
    title: chunk.title ?? null,
    content: chunk.content,
    metadata: chunk.metadata ?? {},
    embedding: chunk.embedding ?? null,
  }));

  return {
    async ensureEmbeddings() {
      if (!llm) {
        return;
      }
      for (const chunk of indexed) {
        if (!chunk.embedding) {
          chunk.embedding = await llm.embed(chunk.content);
        }
      }
    },

    async search({ organizationId, embedding, limit = 5 }) {
      await this.ensureEmbeddings();

      const scoped = indexed.filter(
        (chunk) => chunk.organization_id === organizationId,
      );

      const ranked = scoped
        .map((chunk) => ({
          document_id: chunk.document_id,
          chunk_id: chunk.chunk_id,
          chunk_no: chunk.chunk_no,
          title: chunk.title,
          content: chunk.content,
          metadata: chunk.metadata,
          distance: l2Distance(embedding, chunk.embedding),
        }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, limit);

      return { results: ranked };
    },
  };
}

function assertTenantIsolation(response, organizationId) {
  if (response.organization_id !== organizationId) {
    throw new KbSearchError(
      "Knowledge Base search response organization_id does not match the request",
    );
  }
}

function l2Distance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}
