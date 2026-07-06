import {
  createOpenAiCompatibleLlm,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
} from "./openai-compatible.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createOpenAiLlm({
  apiKey,
  chatModel = DEFAULT_CHAT_MODEL,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  baseUrl = OPENAI_DEFAULT_BASE_URL,
  name = "openai",
  ...rest
}: any = {}) {
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
