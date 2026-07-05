import {
  createOpenAiCompatibleLlm,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
} from "./openai-compatible.mjs";

/**
 * OpenAI LLM provider (ТЗ §12.9).
 *
 * Uses the public OpenAI REST API: `POST {baseUrl}/chat/completions` and
 * `POST {baseUrl}/embeddings` with `Authorization: Bearer <apiKey>`. `baseUrl`
 * defaults to the OpenAI endpoint but can be overridden to point at any
 * OpenAI-compatible gateway. Mirrors the reference OpenAIProvider from
 * https://github.com/rumaster/fbp-engine on top of SVC-AI's fetch core.
 */

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createOpenAiLlm({
  apiKey,
  chatModel = DEFAULT_CHAT_MODEL,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  baseUrl = OPENAI_DEFAULT_BASE_URL,
  name = "openai",
  ...rest
} = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError("createOpenAiLlm requires an apiKey");
  }

  const base = trimTrailingSlash(baseUrl);

  return createOpenAiCompatibleLlm({
    name,
    chatModel,
    embeddingModel,
    chatEndpoint: `${base}/chat/completions`,
    embeddingsEndpoint: `${base}/embeddings`,
    headers: { authorization: `Bearer ${apiKey}` },
    ...rest,
  });
}

function trimTrailingSlash(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}
