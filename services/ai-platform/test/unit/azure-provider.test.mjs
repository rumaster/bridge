import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  createAzureOpenAiLlm,
} from "../../src/providers/azure-provider.mjs";
import {
  chatPayload,
  createMockFetch,
  embeddingPayload,
} from "../helpers/mock-openai.mjs";

const ENDPOINT = "https://contoso.openai.azure.com";

describe("createAzureOpenAiLlm — addressing and auth", () => {
  it("addresses the embedding deployment with an api-key header and api-version query", async () => {
    const fetchImpl = createMockFetch(() => embeddingPayload());
    const llm = createAzureOpenAiLlm({
      apiKey: "azure-secret",
      // A trailing slash on the endpoint must be trimmed.
      endpoint: `${ENDPOINT}/`,
      chatDeployment: "gpt4o",
      embeddingDeployment: "embed3",
      fetchImpl,
    });

    await llm.embed("возврат");

    const [call] = fetchImpl.calls;
    assert.equal(
      call.url,
      `${ENDPOINT}/openai/deployments/embed3/embeddings?api-version=${AZURE_OPENAI_DEFAULT_API_VERSION}`,
    );
    assert.equal(call.headers["api-key"], "azure-secret");
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["content-type"], "application/json");
    // In Azure the request `model` field carries the deployment name.
    assert.equal(call.body.model, "embed3");
  });

  it("addresses the chat deployment and carries the deployment as the model", async () => {
    const fetchImpl = createMockFetch(() =>
      chatPayload(JSON.stringify({ text: "ответ [1]", confidence: 0.7 })),
    );
    const llm = createAzureOpenAiLlm({
      apiKey: "azure-secret",
      endpoint: ENDPOINT,
      chatDeployment: "gpt4o",
      apiVersion: "2024-06-01",
      fetchImpl,
    });

    const result = await llm.generate({ query: "q", chunks: [], organizationId: "org-1" });

    assert.equal(result.text, "ответ [1]");
    const [call] = fetchImpl.calls;
    assert.equal(
      call.url,
      `${ENDPOINT}/openai/deployments/gpt4o/chat/completions?api-version=2024-06-01`,
    );
    assert.equal(call.headers["api-key"], "azure-secret");
    assert.equal(call.body.model, "gpt4o");
  });

  it("defaults the embedding deployment to the chat deployment", async () => {
    const fetchImpl = createMockFetch(() => embeddingPayload());
    const llm = createAzureOpenAiLlm({
      apiKey: "k",
      endpoint: ENDPOINT,
      chatDeployment: "shared",
      fetchImpl,
    });

    await llm.embed("x");
    assert.match(fetchImpl.calls[0].url, /\/deployments\/shared\/embeddings/);
  });

  it("URL-encodes the deployment name", async () => {
    const fetchImpl = createMockFetch(() => embeddingPayload());
    const llm = createAzureOpenAiLlm({
      apiKey: "k",
      endpoint: ENDPOINT,
      chatDeployment: "gpt 4o",
      embeddingDeployment: "embed v3",
      fetchImpl,
    });

    await llm.embed("x");
    assert.match(fetchImpl.calls[0].url, /\/deployments\/embed%20v3\/embeddings/);
  });
});

describe("createAzureOpenAiLlm — validation", () => {
  it("requires an apiKey", () => {
    assert.throws(
      () => createAzureOpenAiLlm({ endpoint: ENDPOINT, chatDeployment: "d" }),
      /requires an apiKey/,
    );
  });

  it("requires an endpoint", () => {
    assert.throws(
      () => createAzureOpenAiLlm({ apiKey: "k", chatDeployment: "d" }),
      /requires an endpoint/,
    );
  });

  it("requires a chatDeployment", () => {
    assert.throws(
      () => createAzureOpenAiLlm({ apiKey: "k", endpoint: ENDPOINT }),
      /requires a chatDeployment/,
    );
  });
});
