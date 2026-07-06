import { KB_EMBEDDING_DIMENSIONS } from "../../../../packages/contracts/src/c3-kb.js";
import { ONBOARDING_ACTIONS } from "../onboarding-pipeline.js";
import { buildPrompt } from "../rag-pipeline.js";
import type { LlmProvider } from "../llm.js";

export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class LlmProviderError extends Error {
  readonly reason?: string;
  readonly status?: number;

  constructor(message: string, options: { cause?: unknown; reason?: string; status?: number } = {}) {
    super(message);
    this.name = "LlmProviderError";
    this.reason = options.reason;
    this.status = options.status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface OpenAiCompatibleLlmOptions {
  name: string;
  chatModel?: string | null;
  embeddingModel?: string;
  dimensions?: number;
  temperature?: number;
  chatEndpoint: string;
  embeddingsEndpoint: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pricing?: Record<string, number>;
}

export function createOpenAiCompatibleLlm({
  name,
  chatModel = DEFAULT_CHAT_MODEL,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  dimensions = KB_EMBEDDING_DIMENSIONS,
  temperature = DEFAULT_TEMPERATURE,
  chatEndpoint,
  embeddingsEndpoint,
  headers,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pricing,
}: OpenAiCompatibleLlmOptions): LlmProvider {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("createOpenAiCompatibleLlm requires a name");
  }
  if (typeof chatEndpoint !== "string" || chatEndpoint.trim() === "") {
    throw new TypeError("createOpenAiCompatibleLlm requires a chatEndpoint");
  }
  if (typeof embeddingsEndpoint !== "string" || embeddingsEndpoint.trim() === "") {
    throw new TypeError("createOpenAiCompatibleLlm requires an embeddingsEndpoint");
  }
  if (!isRecord(headers)) {
    throw new TypeError("createOpenAiCompatibleLlm requires a headers object");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createOpenAiCompatibleLlm requires a fetch implementation");
  }

  const requestHeaders = { "content-type": "application/json", ...headers };

  return {
    name,
    model: chatModel,
    dimensions,
    available: true,
    pricing,

    async embed(text) {
      const body = await postJson(
        embeddingsEndpoint,
        {
          model: embeddingModel,
          input: typeof text === "string" ? text : String(text ?? ""),
        },
        { name, headers: requestHeaders, fetchImpl, timeoutMs },
      );
      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new LlmProviderError(`${name}: embeddings response is missing data[0].embedding`);
      }
      if (Number.isInteger(dimensions) && dimensions > 0 && vector.length !== dimensions) {
        throw new LlmProviderError(
          `${name}: embedding has ${vector.length} dimensions, expected ${dimensions}`,
        );
      }
      return vector;
    },

    async generate({ query, chunks = [], organizationId } = {}) {
      const prompt = buildPrompt({ query, chunks, organizationId });
      const system = [
        prompt.system,
        "Верни строго один JSON-объект по схеме:",
        '{"text": string, "confidence": number, "citations": [{"index": number, "document_id": string, "chunk_id": string}]}.',
        "Поле text — ответ клиенту на русском языке со ссылками на источники в формате [n].",
      ].join(" ");
      const content = await chatCompletion({
        system,
        user: JSON.stringify({ query: prompt.query, context: prompt.context }),
        jsonMode: true,
      });
      const parsed = parseJson(content, "generation", name);
      return normalizeGeneration(parsed, prompt.context, name);
    },

    async interpretOnboarding({ prompt, organizationId, actions } = {}) {
      const allowed = Array.isArray(actions) && actions.length > 0 ? actions : ONBOARDING_ACTIONS;
      const system = [
        "Ты — помощник онбординга Bridge для одной организации.",
        `Работай строго в контексте организации ${organizationId}.`,
        "Ты не изменяешь данные напрямую: опиши ровно одну структурированную команду.",
        `Допустимы только операции: ${allowed.join(", ")}.`,
        "Если запрос не соответствует операции — верни noop.",
        "Верни строго один JSON-объект по схеме:",
        '{"action": string, "params": object, "requiresConfirmation": boolean, "notes": string[]}.',
      ].join(" ");
      const content = await chatCompletion({
        system,
        user: String(prompt ?? ""),
        jsonMode: true,
      });
      const parsed = parseJson(content, "onboarding", name);
      return normalizeOnboarding(parsed, allowed);
    },
  };

  async function chatCompletion({ system, user, jsonMode }) {
    const body: Record<string, unknown> = {
      model: chatModel,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const completion = await postJson(chatEndpoint, body, {
      name,
      headers: requestHeaders,
      fetchImpl,
      timeoutMs,
    });
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LlmProviderError(`${name}: chat completion returned empty content`);
    }
    return content;
  }
}

async function postJson(
  endpoint: string,
  payload: unknown,
  {
    name,
    headers,
    fetchImpl,
    timeoutMs,
  }: { name: string; headers: Record<string, string>; fetchImpl: typeof fetch; timeoutMs: number },
) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason =
      error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : undefined;
    throw new LlmProviderError(`${name}: request to the model API failed`, {
      cause: error,
      reason,
    });
  }

  if (!response.ok) {
    throw new LlmProviderError(`${name}: model API returned HTTP ${response.status}`, {
      status: response.status,
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw new LlmProviderError(`${name}: model API returned invalid JSON`, { cause: error });
  }
}

function parseJson(content: string, context: string, name: string) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new LlmProviderError(`${name}: ${context} response was not valid JSON`, {
      cause: error,
    });
  }
}

function normalizeGeneration(parsed, context, name: string) {
  if (!isRecord(parsed) || typeof parsed.text !== "string" || parsed.text.trim() === "") {
    throw new LlmProviderError(`${name}: generation JSON is missing a non-empty text`);
  }

  const citations =
    Array.isArray(parsed.citations) && parsed.citations.length > 0
      ? parsed.citations
      : context.map((chunk) => ({
          index: chunk.ref,
          document_id: chunk.document_id,
          chunk_id: chunk.chunk_id,
        }));

  return {
    text: parsed.text,
    confidence: clampConfidence(parsed.confidence),
    citations,
  };
}

function normalizeOnboarding(parsed, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  if (!isRecord(parsed)) {
    return noopDraft("model returned a non-object onboarding draft");
  }

  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (!allowedSet.has(action)) {
    return noopDraft(`model proposed an unsupported action: ${action || "<none>"}`);
  }

  return {
    action,
    params: isRecord(parsed.params) ? parsed.params : {},
    requiresConfirmation:
      typeof parsed.requiresConfirmation === "boolean" ? parsed.requiresConfirmation : true,
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note) => typeof note === "string")
      : [],
  };
}

function noopDraft(reason: string) {
  return {
    action: "noop",
    params: { reason },
    requiresConfirmation: false,
    notes: [
      "Backend must keep existing configuration unchanged; the request did not map to a sanctioned operation.",
    ],
  };
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function isRecord(value): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
