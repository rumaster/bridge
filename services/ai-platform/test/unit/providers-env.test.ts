import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRealProviderFactories,
  readLlmEnv,
} from "../../src/providers/env.js";

describe("LLM provider environment wiring", () => {
  it("keeps the deterministic local provider when no real provider is selected", () => {
    assert.equal(readLlmEnv({}), null);
    assert.equal(readLlmEnv({ LLM_PROVIDER: "mock" }), null);
  });

  it("requires provider credentials when OpenAI is selected", () => {
    assert.throws(
      () => readLlmEnv({ LLM_PROVIDER: "openai" }),
      /Missing required environment variable: OPENAI_API_KEY/,
    );
  });

  it("registers OpenAI and Azure factories only when their credentials are present", () => {
    const factories = buildRealProviderFactories({
      OPENAI_API_KEY: "sk-test",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_ENDPOINT: "https://azure-openai.test",
      LLM_MODEL_NAME: "chat-prod",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed-prod",
    });

    assert.deepEqual(Object.keys(factories).sort(), ["azure", "openai"]);
    assert.equal(typeof factories.openai, "function");
    assert.equal(typeof factories.azure, "function");
  });
});
