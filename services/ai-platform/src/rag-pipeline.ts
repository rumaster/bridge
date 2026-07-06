/**
 * Pure RAG building blocks (ТЗ §12.3, §12.7, §22.6). These functions never touch
 * the network or the database — they only shape retrieved Knowledge Base chunks
 * into a ranked, tenant-isolated context, a prompt and C4 source citations, so
 * they are trivially unit-testable with a deterministic embedding mock.
 */

const DEFAULT_TOP_K = 5;
const EXCERPT_MAX_LENGTH = 240;

/** Options accepted by {@link rankChunks} (tenant scope + top-K cut-off). */
export interface RankChunksOptions {
  organizationId?: string;
  topK?: number;
}

/**
 * Rank retrieved chunks for a single organization by ascending L2 distance
 * (closest first) and keep the top-K. Any chunk that does not belong to
 * `organizationId` is dropped defensively — cross-tenant context must never reach
 * the prompt even if an upstream filter regresses.
 */
export function rankChunks(chunks, { organizationId, topK = DEFAULT_TOP_K }: RankChunksOptions = {}) {
  if (!Array.isArray(chunks)) {
    return [];
  }

  return chunks
    .filter((chunk) => isRecord(chunk))
    .filter(
      (chunk) =>
        organizationId === undefined ||
        chunk.organization_id === undefined ||
        chunk.organization_id === organizationId,
    )
    .map((chunk) => ({ ...chunk }))
    .sort((left, right) => distanceOf(left) - distanceOf(right))
    .slice(0, topK);
}

/**
 * Build the prompt handed to the LLM. The system instruction pins the assistant
 * to a single organization and forbids using anything but the supplied context,
 * and only that organization's chunks are embedded into the context block, so the
 * tenant boundary is expressed in the prompt itself (ТЗ §22.6).
 */
export function buildPrompt({ query, chunks, organizationId }) {
  const scoped = rankChunks(chunks, { organizationId, topK: chunks?.length ?? 0 });

  const system = [
    "Ты — ассистент поддержки Bridge для одной организации.",
    `Отвечай только по контексту базы знаний организации ${organizationId}.`,
    "Запрещено использовать материалы других организаций и придумывать факты.",
    "Если контекста недостаточно — честно сообщи об этом и предложи ответить вручную.",
    "Каждое утверждение подкрепляй ссылкой на источник в формате [n].",
  ].join(" ");

  const context = scoped.map((chunk, index) => ({
    ref: index + 1,
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    title: chunk.title ?? null,
    content: chunk.content,
  }));

  return {
    system,
    organization_id: organizationId,
    query,
    context,
  };
}

/**
 * Turn ranked chunks into C4 `sources` entries with human-readable citations.
 * With no chunks a single `none` source marks that the Knowledge Base held no
 * relevant material, keeping the response self-describing.
 */
export function buildSources(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [
      {
        source_type: "none",
        title: "Нет подходящих материалов в базе знаний",
      },
    ];
  }

  return chunks.map((chunk) => ({
    source_type: "knowledge_chunk",
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    title: resolveTitle(chunk),
    excerpt: excerpt(chunk.content),
  }));
}

function resolveTitle(chunk) {
  if (typeof chunk.title === "string" && chunk.title.trim() !== "") {
    return chunk.title;
  }
  if (typeof chunk.document_id === "string") {
    return `Документ ${chunk.document_id}`;
  }
  return "Материал базы знаний";
}

function excerpt(content, maxLength = EXCERPT_MAX_LENGTH) {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function distanceOf(chunk) {
  return typeof chunk.distance === "number" ? chunk.distance : Number.POSITIVE_INFINITY;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
