import { createResilientLlm } from "../llm-facade.mjs";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
} from "./openai-compatible.mjs";
import { createOpenAiLlm, OPENAI_DEFAULT_BASE_URL } from "./openai-provider.mjs";
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  createAzureOpenAiLlm,
} from "./azure-provider.mjs";

/**
 * Wire real LLM providers from environment variables (issue #199, ТЗ §12.9).
 *
 * SVC-AI selects a provider by configuration, never by anything the model returns.
 * The issue asks for a small, explicit env surface:
 *   - LLM_PROVIDER / EMBEDDING_PROVIDER — which provider answers / embeds
 *     (`openai` | `azure`; anything else, incl. unset or `mock`, keeps the
 *     deterministic mock so local runs and the M0 smoke test are unaffected);
 *   - LLM_MODEL_NAME / LLM_EMBEDDING_MODEL_NAME — the chat and embedding models
 *     (for Azure these are deployment names);
 *   - provider credentials (OPENAI_API_KEY, AZURE_OPENAI_API_KEY, …).
 *
 * The chat provider and the embedding provider are chosen independently, so a
 * deployment can (for example) generate answers with Azure while embedding with
 * OpenAI. When both resolve to the same account we reuse a single provider
 * instance; otherwise we compose one (embed from the embedding provider,
 * generate/interpretOnboarding from the chat provider).
 */

const SUPPORTED = new Set(["openai", "azure"]);

/**
 * Read and validate the LLM env surface. Returns a normalized config, or `null`
 * when no real provider is selected (so the caller keeps the deterministic mock).
 */
export function readLlmEnv(env = process.env) {
  const provider = normalizeName(env.LLM_PROVIDER);
  if (!provider || provider === "mock" || provider === "deterministic-mock") {
    return null;
  }
  if (!SUPPORTED.has(provider)) {
    throw new Error(
      `Unsupported LLM_PROVIDER: ${env.LLM_PROVIDER} (expected openai | azure | mock)`,
    );
  }

  const embeddingProvider = normalizeName(env.EMBEDDING_PROVIDER) || provider;
  if (!SUPPORTED.has(embeddingProvider)) {
    throw new Error(
      `Unsupported EMBEDDING_PROVIDER: ${env.EMBEDDING_PROVIDER} (expected openai | azure)`,
    );
  }

  return {
    chat: readChatAccount(provider, env),
    embedding: readEmbeddingAccount(embeddingProvider, env),
    temperature: numberFrom(env.LLM_TEMPERATURE, DEFAULT_TEMPERATURE),
    timeoutMs: readTimeoutMs(env),
  };
}

/** Per-call timeout for real providers (defaults higher than the 5s facade floor). */
export function readTimeoutMs(env = process.env) {
  return numberFrom(env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

/**
 * Build the LLM the RAG assistant/onboarding commander use, wrapped once in the
 * resilient facade (timeout + circuit breaker + shared metrics). Returns `null`
 * when no real provider is configured, so the caller falls back to the mock.
 */
export function buildLlmRuntime({ env = process.env, metrics, fetchImpl } = {}) {
  const config = readLlmEnv(env);
  if (!config) {
    return null;
  }
  const provider = createProviderFromConfig(config, { fetchImpl });
  const llm = createResilientLlm({
    provider,
    metrics,
    timeoutMs: config.timeoutMs,
  });
  return { llm, config };
}

/**
 * Named factories (`openai`, `azure`) for the provider registry so the per-org
 * AI_LLM_CONFIG router (ТЗ §12.9) can select a real provider. Only providers whose
 * credentials are present are registered; the router passes the per-org chat model.
 */
export function buildRealProviderFactories(env = process.env, { fetchImpl } = {}) {
  const factories = {};
  const temperature = numberFrom(env.LLM_TEMPERATURE, DEFAULT_TEMPERATURE);
  const timeoutMs = readTimeoutMs(env);
  const embeddingModel = optional(env.LLM_EMBEDDING_MODEL_NAME, DEFAULT_EMBEDDING_MODEL);

  if (nonEmpty(env.OPENAI_API_KEY)) {
    const baseUrl = optional(env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL);
    const defaultChatModel = optional(env.LLM_MODEL_NAME, DEFAULT_CHAT_MODEL);
    factories.openai = ({ model } = {}) =>
      createOpenAiLlm({
        apiKey: env.OPENAI_API_KEY,
        baseUrl,
        chatModel: model ?? defaultChatModel,
        embeddingModel,
        temperature,
        timeoutMs,
        fetchImpl,
      });
  }

  if (nonEmpty(env.AZURE_OPENAI_API_KEY) && nonEmpty(env.AZURE_OPENAI_ENDPOINT)) {
    const endpoint = env.AZURE_OPENAI_ENDPOINT;
    const apiVersion = optional(
      env.AZURE_OPENAI_API_VERSION,
      AZURE_OPENAI_DEFAULT_API_VERSION,
    );
    const embeddingDeployment = optional(
      env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      optional(env.LLM_EMBEDDING_MODEL_NAME, ""),
    );
    factories.azure = ({ model } = {}) =>
      createAzureOpenAiLlm({
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint,
        apiVersion,
        chatDeployment: model ?? optional(env.LLM_MODEL_NAME, ""),
        embeddingDeployment: embeddingDeployment || undefined,
        temperature,
        timeoutMs,
        fetchImpl,
      });
  }

  return factories;
}

/**
 * Instantiate the (possibly composite) provider described by a normalized config.
 * When the chat and embedding accounts are identical a single instance serves
 * both; otherwise embed and generate are routed to their own providers.
 */
export function createProviderFromConfig(config, { fetchImpl } = {}) {
  const { chat, embedding, temperature, timeoutMs } = config;
  const common = { temperature, timeoutMs, fetchImpl };

  if (sameAccount(chat, embedding)) {
    return instantiate(chat, {
      chatModel: chat.model,
      embeddingModel: embedding.model,
      ...common,
    });
  }

  const chatProvider = instantiate(chat, {
    chatModel: chat.model,
    embeddingModel: chat.model,
    ...common,
  });
  const embeddingProvider = instantiate(embedding, {
    chatModel: embedding.model,
    embeddingModel: embedding.model,
    ...common,
  });
  return createCompositeLlm({ chat: chatProvider, embedding: embeddingProvider });
}

/**
 * Compose a provider that embeds with one instance and generates with another,
 * so LLM_PROVIDER and EMBEDDING_PROVIDER can differ (issue #199).
 */
export function createCompositeLlm({ chat, embedding }) {
  return {
    name: chat.name === embedding.name ? chat.name : `${chat.name}+${embedding.name}`,
    model: chat.model ?? null,
    embeddingModel: embedding.embeddingModel,
    dimensions: embedding.dimensions,
    available: true,
    pricing: chat.pricing,
    embed: (text) => embedding.embed(text),
    generate: (request) => chat.generate(request),
    interpretOnboarding: (request) => chat.interpretOnboarding(request),
  };
}

function instantiate(account, { chatModel, embeddingModel, temperature, timeoutMs, fetchImpl }) {
  if (account.provider === "openai") {
    return createOpenAiLlm({
      apiKey: account.apiKey,
      baseUrl: account.baseUrl,
      chatModel,
      embeddingModel,
      temperature,
      timeoutMs,
      fetchImpl,
    });
  }
  return createAzureOpenAiLlm({
    apiKey: account.apiKey,
    endpoint: account.endpoint,
    apiVersion: account.apiVersion,
    chatDeployment: chatModel,
    embeddingDeployment: embeddingModel,
    temperature,
    timeoutMs,
    fetchImpl,
  });
}

function readChatAccount(provider, env) {
  if (provider === "openai") {
    return {
      provider,
      apiKey: required(env, "OPENAI_API_KEY"),
      baseUrl: optional(env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL),
      model: optional(env.LLM_MODEL_NAME, DEFAULT_CHAT_MODEL),
    };
  }
  return {
    provider,
    apiKey: required(env, "AZURE_OPENAI_API_KEY"),
    endpoint: required(env, "AZURE_OPENAI_ENDPOINT"),
    apiVersion: optional(env.AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEFAULT_API_VERSION),
    // In Azure the chat deployment is the model name.
    model: required(env, "LLM_MODEL_NAME"),
  };
}

function readEmbeddingAccount(provider, env) {
  if (provider === "openai") {
    return {
      provider,
      apiKey: required(env, "OPENAI_API_KEY"),
      baseUrl: optional(env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL),
      model: optional(env.LLM_EMBEDDING_MODEL_NAME, DEFAULT_EMBEDDING_MODEL),
    };
  }
  return {
    provider,
    apiKey: required(env, "AZURE_OPENAI_API_KEY"),
    endpoint: required(env, "AZURE_OPENAI_ENDPOINT"),
    apiVersion: optional(env.AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEFAULT_API_VERSION),
    // Prefer a dedicated embedding deployment; fall back to LLM_EMBEDDING_MODEL_NAME.
    model:
      firstNonEmpty(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, env.LLM_EMBEDDING_MODEL_NAME) ??
      throwMissing("AZURE_OPENAI_EMBEDDING_DEPLOYMENT (or LLM_EMBEDDING_MODEL_NAME)"),
  };
}

function sameAccount(a, b) {
  if (a.provider !== b.provider) {
    return false;
  }
  if (a.provider === "openai") {
    return a.apiKey === b.apiKey && a.baseUrl === b.baseUrl;
  }
  return (
    a.apiKey === b.apiKey &&
    a.endpoint === b.endpoint &&
    a.apiVersion === b.apiVersion
  );
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function optional(value, fallback) {
  return nonEmpty(value) ? value : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) {
      return value;
    }
  }
  return null;
}

function numberFrom(value, fallback) {
  if (!nonEmpty(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(env, name) {
  const value = env[name];
  if (!nonEmpty(value)) {
    throwMissing(name);
  }
  return value;
}

function throwMissing(name) {
  throw new Error(`Missing required environment variable: ${name}`);
}
