import { createResilientLlm } from "../llm-facade.js";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
} from "./openai-compatible.js";
import { createOpenAiLlm, OPENAI_DEFAULT_BASE_URL } from "./openai-provider.js";
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  createAzureOpenAiLlm,
} from "./azure-provider.js";

const SUPPORTED = new Set(["openai", "azure"]);

export function readLlmEnv(env: Record<string, string | undefined> = process.env) {
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

export function readTimeoutMs(env: Record<string, string | undefined> = process.env) {
  return numberFrom(env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

export function buildLlmRuntime({ env = process.env, metrics, fetchImpl }: any = {}) {
  const config = readLlmEnv(env);
  if (!config) {
    return null;
  }

  const provider = createProviderFromConfig(config, { fetchImpl });
  return {
    config,
    llm: createResilientLlm({
      provider,
      metrics,
      timeoutMs: config.timeoutMs,
    }),
  };
}

export function buildRealProviderFactories(
  env: Record<string, string | undefined> = process.env,
  { fetchImpl }: any = {},
) {
  const factories: Record<string, any> = {};
  const temperature = numberFrom(env.LLM_TEMPERATURE, DEFAULT_TEMPERATURE);
  const timeoutMs = readTimeoutMs(env);
  const embeddingModel = optional(env.LLM_EMBEDDING_MODEL_NAME, DEFAULT_EMBEDDING_MODEL);

  if (nonEmpty(env.OPENAI_API_KEY)) {
    const baseUrl = optional(env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL);
    const defaultChatModel = optional(env.LLM_MODEL_NAME, DEFAULT_CHAT_MODEL);
    factories.openai = ({ model }: { model?: string | null } = {}) =>
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
    const apiVersion = optional(env.AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEFAULT_API_VERSION);
    const embeddingDeployment = optional(
      env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      optional(env.LLM_EMBEDDING_MODEL_NAME, ""),
    );
    factories.azure = ({ model }: { model?: string | null } = {}) =>
      createAzureOpenAiLlm({
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint: env.AZURE_OPENAI_ENDPOINT,
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

export function createProviderFromConfig(config, { fetchImpl }: any = {}) {
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

  return {
    name: chatProvider.name === embeddingProvider.name
      ? chatProvider.name
      : `${chatProvider.name}+${embeddingProvider.name}`,
    model: chatProvider.model ?? null,
    dimensions: embeddingProvider.dimensions,
    available: true,
    embed: (text) => embeddingProvider.embed(text),
    generate: (request) => chatProvider.generate(request),
    interpretOnboarding: (request) => chatProvider.interpretOnboarding(request),
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

function readChatAccount(provider: string, env: Record<string, string | undefined>) {
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
    model: required(env, "LLM_MODEL_NAME"),
  };
}

function readEmbeddingAccount(provider: string, env: Record<string, string | undefined>) {
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
    model:
      firstNonEmpty(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, env.LLM_EMBEDDING_MODEL_NAME) ??
      throwMissing("AZURE_OPENAI_EMBEDDING_DEPLOYMENT (or LLM_EMBEDDING_MODEL_NAME)"),
  };
}

function sameAccount(left, right) {
  if (left.provider !== right.provider) {
    return false;
  }
  if (left.provider === "openai") {
    return left.apiKey === right.apiKey && left.baseUrl === right.baseUrl;
  }
  return (
    left.apiKey === right.apiKey &&
    left.endpoint === right.endpoint &&
    left.apiVersion === right.apiVersion
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
  return values.find((value) => nonEmpty(value)) ?? null;
}

function numberFrom(value, fallback: number) {
  if (!nonEmpty(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  if (!nonEmpty(value)) {
    throwMissing(name);
  }
  return value;
}

function throwMissing(name: string): never {
  throw new Error(`Missing required environment variable: ${name}`);
}
