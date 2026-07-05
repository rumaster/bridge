import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLlmRuntime,
  buildRealProviderFactories,
  createProviderFromConfig,
  readLlmEnv,
  readTimeoutMs,
} from "../../src/providers/env.mjs";
import { createAiMetrics } from "../../src/metrics.mjs";
import {
  chatPayload,
  createMockFetch,
  embeddingPayload,
  routeByPath,
} from "../helpers/mock-openai.mjs";

describe("readLlmEnv — env surface (issue #199, ТЗ §12.9)", () => {
  it("returns null when no real provider is selected (keeps the deterministic mock)", () => {
    assert.equal(readLlmEnv({}), null);
    assert.equal(readLlmEnv({ LLM_PROVIDER: "" }), null);
    assert.equal(readLlmEnv({ LLM_PROVIDER: "mock" }), null);
    assert.equal(readLlmEnv({ LLM_PROVIDER: "deterministic-mock" }), null);
  });

  it("throws on an unsupported chat provider", () => {
    assert.throws(
      () => readLlmEnv({ LLM_PROVIDER: "cohere" }),
      /Unsupported LLM_PROVIDER/,
    );
  });

  it("throws on an unsupported embedding provider", () => {
    assert.throws(
      () =>
        readLlmEnv({
          LLM_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-1",
          EMBEDDING_PROVIDER: "cohere",
        }),
      /Unsupported EMBEDDING_PROVIDER/,
    );
  });

  it("reads an OpenAI account with model defaults", () => {
    const config = readLlmEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-1" });
    assert.equal(config.chat.provider, "openai");
    assert.equal(config.chat.apiKey, "sk-1");
    assert.equal(config.chat.model, "gpt-4o-mini");
    assert.equal(config.embedding.provider, "openai");
    assert.equal(config.embedding.model, "text-embedding-3-small");
    assert.equal(config.temperature, 0.2);
    assert.equal(config.timeoutMs, 30000);
  });

  it("honors explicit model names and temperature/timeout overrides", () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-1",
      OPENAI_BASE_URL: "https://gateway.local/v1",
      LLM_MODEL_NAME: "gpt-4o",
      LLM_EMBEDDING_MODEL_NAME: "text-embedding-3-large",
      LLM_TEMPERATURE: "0.7",
      LLM_TIMEOUT_MS: "12000",
    });
    assert.equal(config.chat.baseUrl, "https://gateway.local/v1");
    assert.equal(config.chat.model, "gpt-4o");
    assert.equal(config.embedding.model, "text-embedding-3-large");
    assert.equal(config.temperature, 0.7);
    assert.equal(config.timeoutMs, 12000);
  });

  it("requires OPENAI_API_KEY for an OpenAI provider", () => {
    assert.throws(() => readLlmEnv({ LLM_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  });

  it("reads an Azure account (deployments double as model names)", () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "azure",
      AZURE_OPENAI_API_KEY: "az-1",
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
      LLM_MODEL_NAME: "gpt4o-deploy",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed-deploy",
    });
    assert.equal(config.chat.provider, "azure");
    assert.equal(config.chat.model, "gpt4o-deploy");
    assert.equal(config.chat.endpoint, "https://x.openai.azure.com");
    assert.equal(config.chat.apiVersion, "2024-10-21");
    assert.equal(config.embedding.provider, "azure");
    assert.equal(config.embedding.model, "embed-deploy");
  });

  it("requires an Azure chat deployment (LLM_MODEL_NAME)", () => {
    assert.throws(
      () =>
        readLlmEnv({
          LLM_PROVIDER: "azure",
          AZURE_OPENAI_API_KEY: "az",
          AZURE_OPENAI_ENDPOINT: "https://x",
        }),
      /LLM_MODEL_NAME/,
    );
  });

  it("requires an Azure embedding deployment", () => {
    assert.throws(
      () =>
        readLlmEnv({
          LLM_PROVIDER: "azure",
          AZURE_OPENAI_API_KEY: "az",
          AZURE_OPENAI_ENDPOINT: "https://x",
          LLM_MODEL_NAME: "gpt",
        }),
      /AZURE_OPENAI_EMBEDDING_DEPLOYMENT/,
    );
  });

  it("falls back to LLM_EMBEDDING_MODEL_NAME for the Azure embedding deployment", () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "azure",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_ENDPOINT: "https://x",
      LLM_MODEL_NAME: "gpt",
      LLM_EMBEDDING_MODEL_NAME: "embed",
    });
    assert.equal(config.embedding.model, "embed");
  });

  it("lets the chat and embedding providers differ (LLM_PROVIDER vs EMBEDDING_PROVIDER)", () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "azure",
      EMBEDDING_PROVIDER: "openai",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_ENDPOINT: "https://x",
      LLM_MODEL_NAME: "gpt",
      OPENAI_API_KEY: "sk-1",
    });
    assert.equal(config.chat.provider, "azure");
    assert.equal(config.embedding.provider, "openai");
    assert.equal(config.embedding.model, "text-embedding-3-small");
  });
});

describe("readTimeoutMs", () => {
  it("defaults to 30000 and honors a numeric LLM_TIMEOUT_MS", () => {
    assert.equal(readTimeoutMs({}), 30000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: "9000" }), 9000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: "not-a-number" }), 30000);
  });
});

describe("createProviderFromConfig", () => {
  it("reuses one instance when the chat and embedding accounts match", async () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-1",
      LLM_EMBEDDING_MODEL_NAME: "text-embedding-3-large",
    });
    const fetchImpl = routeByPath({
      embedding: embeddingPayload(),
      chat: chatPayload(JSON.stringify({ text: "ответ [1]" })),
    });

    const provider = createProviderFromConfig(config, { fetchImpl });
    assert.equal(provider.name, "openai");

    await provider.embed("x");
    await provider.generate({ query: "q", chunks: [], organizationId: "o" });

    const embedCall = fetchImpl.calls.find((c) => c.url.endsWith("/embeddings"));
    const chatCall = fetchImpl.calls.find((c) => c.url.endsWith("/chat/completions"));
    assert.equal(embedCall.body.model, "text-embedding-3-large");
    assert.equal(chatCall.body.model, "gpt-4o-mini");
  });

  it("composes a provider when chat and embedding differ, routing each call to its own account", async () => {
    const config = readLlmEnv({
      LLM_PROVIDER: "azure",
      EMBEDDING_PROVIDER: "openai",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
      LLM_MODEL_NAME: "gpt4o",
      OPENAI_API_KEY: "sk-1",
    });
    const fetchImpl = createMockFetch((url) =>
      url.includes("/embeddings")
        ? embeddingPayload()
        : chatPayload(JSON.stringify({ text: "ответ [1]" })),
    );

    const provider = createProviderFromConfig(config, { fetchImpl });
    assert.equal(provider.name, "azure+openai");

    await provider.embed("x");
    await provider.generate({ query: "q", chunks: [], organizationId: "o" });

    const embedCall = fetchImpl.calls.find((c) => c.url.includes("/embeddings"));
    const chatCall = fetchImpl.calls.find((c) => c.url.includes("/chat/completions"));
    // Embeddings must hit OpenAI, chat must hit Azure.
    assert.match(embedCall.url, /api\.openai\.com/);
    assert.match(chatCall.url, /contoso\.openai\.azure\.com/);
  });
});

describe("buildRealProviderFactories", () => {
  it("registers no real factories without credentials", () => {
    assert.deepEqual(Object.keys(buildRealProviderFactories({})), []);
  });

  it("registers openai when OPENAI_API_KEY is present", () => {
    const factories = buildRealProviderFactories({ OPENAI_API_KEY: "sk" });
    assert.deepEqual(Object.keys(factories), ["openai"]);
    const provider = factories.openai({ model: "gpt-4o" });
    assert.equal(provider.name, "openai");
    assert.equal(provider.model, "gpt-4o");
  });

  it("registers azure when its endpoint and key are present", () => {
    const factories = buildRealProviderFactories({
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
    });
    assert.deepEqual(Object.keys(factories), ["azure"]);
    const provider = factories.azure({ model: "gpt4o" });
    assert.equal(provider.name, "azure");
    assert.equal(provider.model, "gpt4o");
  });

  it("registers both when both providers are configured", () => {
    const factories = buildRealProviderFactories({
      OPENAI_API_KEY: "sk",
      AZURE_OPENAI_API_KEY: "az",
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
    });
    assert.deepEqual(Object.keys(factories).sort(), ["azure", "openai"]);
  });
});

describe("buildLlmRuntime", () => {
  it("returns null when no real provider is configured", () => {
    assert.equal(buildLlmRuntime({ env: {} }), null);
  });

  it("wraps the provider in the resilient facade and records shared metrics", async () => {
    const metrics = createAiMetrics();
    const fetchImpl = createMockFetch(() => embeddingPayload());
    const runtime = buildLlmRuntime({
      env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-1" },
      metrics,
      fetchImpl,
    });

    assert.ok(runtime);
    assert.equal(runtime.llm.resilient, true);
    assert.equal(runtime.config.timeoutMs, 30000);

    const vector = await runtime.llm.embed("возврат");
    assert.equal(vector.length, 1536);
    assert.equal(metrics.snapshot().llm_call_total, 1);
  });
});
