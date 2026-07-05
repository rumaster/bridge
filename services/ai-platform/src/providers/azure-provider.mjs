import { createOpenAiCompatibleLlm } from "./openai-compatible.mjs";

/**
 * Azure OpenAI LLM provider (ТЗ §12.9).
 *
 * Azure exposes the same wire protocol as OpenAI but addresses models by
 * *deployment* and authenticates with an `api-key` header instead of a bearer
 * token:
 *   POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…
 *   POST {endpoint}/openai/deployments/{deployment}/embeddings?api-version=…
 * In Azure the request `model` field carries the deployment name, so the chat and
 * embedding deployments double as the model names. Mirrors the reference
 * AzureOpenAIProvider from https://github.com/rumaster/fbp-engine on top of
 * SVC-AI's fetch core.
 */

export const AZURE_OPENAI_DEFAULT_API_VERSION = "2024-10-21";

export function createAzureOpenAiLlm({
  apiKey,
  endpoint,
  chatDeployment,
  embeddingDeployment = chatDeployment,
  apiVersion = AZURE_OPENAI_DEFAULT_API_VERSION,
  name = "azure",
  ...rest
} = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError("createAzureOpenAiLlm requires an apiKey");
  }
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new TypeError("createAzureOpenAiLlm requires an endpoint");
  }
  if (typeof chatDeployment !== "string" || chatDeployment.trim() === "") {
    throw new TypeError("createAzureOpenAiLlm requires a chatDeployment");
  }

  const base = trimTrailingSlash(endpoint);
  const query = `?api-version=${encodeURIComponent(apiVersion)}`;

  return createOpenAiCompatibleLlm({
    name,
    // In Azure the deployment name is what the request `model` field must carry.
    chatModel: chatDeployment,
    embeddingModel: embeddingDeployment,
    chatEndpoint: `${base}/openai/deployments/${encodeURIComponent(chatDeployment)}/chat/completions${query}`,
    embeddingsEndpoint: `${base}/openai/deployments/${encodeURIComponent(embeddingDeployment)}/embeddings${query}`,
    headers: { "api-key": apiKey },
    ...rest,
  });
}

function trimTrailingSlash(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}
