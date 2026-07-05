import { KB_EMBEDDING_DIMENSIONS } from "../../../../packages/contracts/src/c3-kb.mjs";
import { buildPrompt } from "../rag-pipeline.mjs";
import { ONBOARDING_ACTIONS } from "../onboarding-pipeline.mjs";

/**
 * OpenAI-compatible LLM provider core (ТЗ §12.9).
 *
 * A single implementation of the swappable provider interface (embed / generate /
 * interpretOnboarding) on top of the OpenAI REST wire protocol
 * (`POST …/chat/completions`, `POST …/embeddings`). OpenAI and Azure OpenAI differ
 * only in how the endpoint URL and the auth header are built, so both providers
 * (openai-provider.mjs, azure-provider.mjs) delegate here after computing those two
 * things. Modelled after the reference implementation
 * https://github.com/rumaster/fbp-engine (OpenAIProvider / AzureOpenAIProvider),
 * adapted to SVC-AI's zero-dependency, dependency-injected `fetch` style
 * (see kb-search.mjs) so it is trivially unit-testable with a mock `fetchImpl`.
 *
 * The provider only ever talks to the model API — it never touches the database or
 * runs Knowledge Base search itself (ТЗ §12.10, §22.6): tenant isolation lives in
 * the prompt (buildPrompt) and in Backend's pgvector search. Any transport,
 * protocol or shape failure surfaces as an LlmProviderError so the RAG assistant
 * and the onboarding commander degrade gracefully (ТЗ §5.4).
 */

/** Default OpenAI chat model (cheap, fast, good enough for grounded RAG answers). */
export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
/** Default embeddings model — 1536 dimensions, matches KB_EMBEDDING_DIMENSIONS. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
/** Low temperature keeps grounded answers close to the retrieved context. */
export const DEFAULT_TEMPERATURE = 0.2;
/** Per-call timeout for the provider's own AbortSignal (the facade also guards). */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class LlmProviderError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message);
    this.name = "LlmProviderError";
    if (cause !== undefined) {
      this.cause = cause;
    }
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/**
 * Build a provider from the two things OpenAI and Azure disagree on — the endpoint
 * URLs and the auth headers — plus the model names. Everything else (request shape,
 * JSON mode, response parsing, error handling) is shared.
 */
export function createOpenAiCompatibleLlm({
  name,
  chatModel,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  dimensions = KB_EMBEDDING_DIMENSIONS,
  temperature = DEFAULT_TEMPERATURE,
  chatEndpoint,
  embeddingsEndpoint,
  headers,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pricing,
} = {}) {
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
    model: chatModel ?? null,
    embeddingModel,
    dimensions,
    available: true,
    pricing,

    async embed(text) {
      const input = typeof text === "string" ? text : String(text ?? "");
      const body = await postJson(embeddingsEndpoint, {
        model: embeddingModel,
        input,
      });

      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new LlmProviderError(
          `${name}: embeddings response is missing data[0].embedding`,
        );
      }
      if (
        Number.isInteger(dimensions) &&
        dimensions > 0 &&
        vector.length !== dimensions
      ) {
        throw new LlmProviderError(
          `${name}: embedding has ${vector.length} dimensions, expected ${dimensions} ` +
            "(the Knowledge Base stores 1536-dim vectors — use text-embedding-3-small)",
        );
      }
      return vector;
    },

    async generate({ query, chunks = [], organizationId } = {}) {
      const prompt = buildPrompt({ query, chunks, organizationId });
      const system = [
        prompt.system,
        "Верни СТРОГО один JSON-объект по схеме:",
        '{"text": string, "confidence": number в диапазоне 0..1, ' +
          '"citations": [{"index": number, "document_id": string, "chunk_id": string}]}.',
        "Поле text — ответ клиенту на русском языке со ссылками на источники в формате [n]. " +
          "Не добавляй ничего вне JSON-объекта.",
      ].join(" ");
      const user = JSON.stringify({
        query: prompt.query,
        context: prompt.context,
      });

      const content = await chatCompletion({ system, user, jsonMode: true });
      const parsed = parseJson(content, "generation", name);
      return normalizeGeneration(parsed, prompt.context, name);
    },

    async interpretOnboarding({ prompt, organizationId, actions } = {}) {
      const allowed =
        Array.isArray(actions) && actions.length > 0 ? actions : ONBOARDING_ACTIONS;
      const system = [
        "Ты — помощник онбординга Bridge для одной организации.",
        `Работай строго в контексте организации ${organizationId} и только с её настройками.`,
        "Запрещено обращаться к данным или настройкам других организаций.",
        "Ты не изменяешь данные напрямую: опиши РОВНО одну структурированную команду,",
        "которую Backend применит после проверки полномочий и валидации.",
        `Допустимы только санкционированные операции: ${allowed.join(", ")}.`,
        "Если запрос не соответствует ни одной операции — верни noop.",
        "Верни СТРОГО один JSON-объект по схеме:",
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
    const messages = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: user });

    const body = { model: chatModel, temperature, messages };
    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const completion = await postJson(chatEndpoint, body);
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LlmProviderError(`${name}: chat completion returned empty content`);
    }
    return content;
  }

  async function postJson(endpoint, payload) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const wrapped = new LlmProviderError(`${name}: request to the model API failed`, {
        cause: error,
      });
      // AbortSignal.timeout rejects with a TimeoutError (older Node: AbortError);
      // tag it so the assistant classifies the degradation as a timeout (ТЗ §5.4).
      if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        wrapped.reason = "timeout";
      }
      throw wrapped;
    }

    if (!response.ok) {
      throw new LlmProviderError(
        `${name}: model API returned HTTP ${response.status}`,
        { status: response.status },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new LlmProviderError(`${name}: model API returned invalid JSON`, {
        cause: error,
      });
    }
  }
}

function parseJson(content, context, name = "provider") {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new LlmProviderError(
      `${name}: ${context} response was not valid JSON`,
      { cause: error },
    );
  }
}

/**
 * Coerce the model's generation JSON into the `{ text, confidence, citations }`
 * shape the RAG assistant expects. `text` is required; confidence is clamped to
 * [0, 1]; citations default to the supplied context so the answer is never left
 * without sources.
 */
function normalizeGeneration(parsed, context, name) {
  if (!isRecord(parsed) || typeof parsed.text !== "string" || parsed.text.trim() === "") {
    throw new LlmProviderError(`${name}: generation JSON is missing a non-empty "text"`);
  }

  const citations =
    Array.isArray(parsed.citations) && parsed.citations.length > 0
      ? parsed.citations
      : context.map((chunk) => ({
          index: chunk.ref,
          document_id: chunk.document_id,
          chunk_id: chunk.chunk_id,
          title: chunk.title ?? null,
        }));

  return {
    text: parsed.text,
    confidence: clampConfidence(parsed.confidence),
    citations,
  };
}

/**
 * Coerce the model's onboarding JSON into a valid draft command. An action outside
 * the sanctioned §12.6 catalogue is downgraded to `noop` (with the original kept in
 * the notes) so an off-catalogue hallucination degrades gracefully instead of
 * failing the request — Backend still owns the final validation and application.
 */
function normalizeOnboarding(parsed, allowed) {
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
      typeof parsed.requiresConfirmation === "boolean"
        ? parsed.requiresConfirmation
        : true,
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note) => typeof note === "string")
      : [],
  };
}

function noopDraft(reason) {
  return {
    action: "noop",
    params: { reason },
    requiresConfirmation: false,
    notes: [
      "Backend must keep the existing configuration unchanged; the request did not " +
        "map to a sanctioned operation.",
    ],
  };
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
