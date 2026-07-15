import { KB_EMBEDDING_DIMENSIONS } from "../../../packages/contracts/src/c3-kb.js";

/**
 * Swappable LLM abstraction for SVC-AI (ТЗ §12.9).
 *
 * A provider exposes three capabilities:
 *   - embed(text): Promise<number[]>       — a `KB_EMBEDDING_DIMENSIONS`-vector.
 *   - generate({ query, chunks }): Promise<{ text, confidence, citations }>
 *   - interpretOnboarding({ prompt, organizationId }): Promise<draft>
 *
 * The first two power the RAG assistant (CP-3); the third powers AI Onboarding
 * (CP-5): it turns an administrator's natural-language request into a *draft*
 * structured command ({ action, params, requiresConfirmation, notes }) that the
 * onboarding pipeline validates against the §12.6 catalogue before assembling a
 * C4 command. The model only ever proposes a description — it never applies it.
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
 * Swappable LLM provider surface (embed / generate / interpretOnboarding) plus
 * the descriptive metadata the registry and resilient facade read. Every member
 * is optional so partial test doubles, the unavailable variant and the resilient
 * wrapper all satisfy the same structural type.
 */
export interface LlmProvider {
  name?: string;
  model?: string | null;
  pricing?: Record<string, number>;
  dimensions?: number;
  available?: boolean;
  resilient?: boolean;
  embed?(text?: any): Promise<any>;
  generate?(args?: any): Promise<any>;
  interpretOnboarding?(args?: any): Promise<any>;
  /**
   * Сырой вызов модели для узла «LLM» контракта Workflow 2.0 (добавлен
   * 2026-07-15). Отличается от `generate` тем, что не строит RAG-промпт и не
   * возвращает цитат: промпт задан целиком вызывающей стороной.
   */
  complete?(args?: any): Promise<any>;
  getBreakerState?(): any;
}

/** Options accepted by {@link createDeterministicMockLlm}. */
export interface DeterministicMockLlmOptions {
  dimensions?: number;
  name?: string;
  model?: string | null;
  pricing?: Record<string, number>;
}

/** Options accepted by {@link createUnavailableLlm}. */
export interface UnavailableLlmOptions {
  reason?: string;
  dimensions?: number;
}

/**
 * Create the deterministic mock LLM provider. No randomness, no network — same
 * input always yields the same embedding and the same generated answer.
 *
 * `name`, `model` and `pricing` let the provider registry stand up several
 * distinct mock providers/models (ТЗ §12.9) — e.g. an economy and a premium
 * model with different per-call cost — while keeping identical, reproducible
 * behaviour. `pricing` is consumed by the resilient facade's cost estimate
 * (micro-units per 1000 characters, per capability).
 */
export function createDeterministicMockLlm({
  dimensions = LLM_EMBEDDING_DIMENSIONS,
  name = "deterministic-mock",
  model = null,
  pricing,
}: DeterministicMockLlmOptions = {}): LlmProvider {
  return {
    name,
    model,
    pricing,
    dimensions,
    available: true,

    async embed(text) {
      return embedText(text, dimensions);
    },

    async generate({ query, chunks = [] }) {
      return generateAnswer({ query, chunks });
    },

    async interpretOnboarding({ prompt }) {
      return interpretOnboardingPrompt(prompt);
    },

    async complete({ prompt }) {
      return completePrompt(prompt, model);
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
}: UnavailableLlmOptions = {}): LlmProvider {
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
    async interpretOnboarding() {
      fail();
    },
    async complete() {
      fail();
    },
  };
}

export class LlmUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string = "unavailable") {
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

/**
 * Deterministic AI Onboarding interpretation (ТЗ §12.4, §12.6). Maps an
 * administrator's natural-language request onto exactly one *draft* structured
 * command — an action from the §12.6 catalogue plus its parameters. The draft
 * never carries an `organization_id`: the onboarding pipeline pins tenancy to
 * the authenticated request so the model can never target another organization
 * (ТЗ §22.6). The command is a description only — Backend validates, authorizes
 * and applies it (ТЗ §12.6, §13.13). Same prompt in → same draft out.
 */
export function interpretOnboardingPrompt(prompt) {
  const normalizedPrompt = normalizeText(prompt);

  if (normalizedPrompt.includes("telegram") || normalizedPrompt.includes("телеграм")) {
    return {
      action: "channel.connect",
      params: {
        channel_type: "telegram",
        display_name: "Telegram",
        mode: "mock",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate administrator permissions and channel credentials before applying.",
      ],
    };
  }

  if (
    normalizedPrompt.includes("часовой пояс") ||
    normalizedPrompt.includes("timezone") ||
    normalizedPrompt.includes("europe/moscow")
  ) {
    return {
      action: "configuration.upsert",
      params: {
        key: "organization.timezone",
        value: extractTimezone(prompt),
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate the configuration key, value format and organization scope.",
      ],
    };
  }

  if (normalizedPrompt.includes("пригласи") || normalizedPrompt.includes("invite")) {
    return {
      action: "user.invite",
      params: {
        role: "manager",
        delivery: "manual",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate role assignment and invitation target before applying.",
      ],
    };
  }

  if (normalizedPrompt.includes("название") || normalizedPrompt.includes("name")) {
    return {
      action: "organization.update_profile",
      params: {
        display_name: "M0 Mock Organization",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate organization profile fields before applying.",
      ],
    };
  }

  return {
    action: "noop",
    params: {
      reason: "unsupported_m0_prompt",
    },
    requiresConfirmation: false,
    notes: [
      "M0 deterministic mock could not map the prompt to a supported Backend operation.",
    ],
  };
}

function extractTimezone(prompt) {
  const match = String(prompt ?? "").match(/[A-Za-z]+\/[A-Za-z_]+/);
  return match ? match[0] : "Europe/Moscow";
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Детерминированный сырой ответ модели (узел «LLM» контракта Workflow 2.0).
 *
 * Ни случайности, ни сети: один и тот же промпт всегда даёт один и тот же текст —
 * иначе тест-прогон схемы был бы невоспроизводим, а ветвление по ответу LLM
 * «плавало» бы от запуска к запуску.
 *
 * Ответ намеренно называет себя заглушкой: схема, ветвящаяся по тексту ответа, не
 * должна принять его за настоящую генерацию. Формально это отмечено полем
 * `degraded` в ответе C4, но текст обязан быть честным и сам по себе.
 */
function completePrompt(prompt, model) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";

  return {
    text:
      "LLM-провайдер не настроен: это детерминированная заглушка. " +
      `Промпт: «${summarize(trimmed)}»`,
    model: model ?? null,
  };
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
