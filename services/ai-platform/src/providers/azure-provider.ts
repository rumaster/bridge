import { createOpenAiCompatibleLlm } from "./openai-compatible.js";

export const AZURE_OPENAI_DEFAULT_API_VERSION = "2024-10-21";

export function createAzureOpenAiLlm({
  apiKey,
  endpoint,
  chatDeployment,
  embeddingDeployment = chatDeployment,
  apiVersion = AZURE_OPENAI_DEFAULT_API_VERSION,
  name = "azure",
  ...rest
}: any = {}) {
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
  const encodedChat = encodeURIComponent(chatDeployment);
  const encodedEmbedding = encodeURIComponent(embeddingDeployment);

  return createOpenAiCompatibleLlm({
    name,
    chatModel: chatDeployment,
    embeddingModel: embeddingDeployment,
    chatEndpoint: `${base}/openai/deployments/${encodedChat}/chat/completions${query}`,
    embeddingsEndpoint: `${base}/openai/deployments/${encodedEmbedding}/embeddings${query}`,
    headers: { "api-key": apiKey },
    ...rest,
  });
}

function trimTrailingSlash(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}
