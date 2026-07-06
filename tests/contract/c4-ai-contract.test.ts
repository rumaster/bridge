import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("API <-> AI M0 C4 contract", () => {
  it("publishes the frozen C4 OpenAPI operations", () => {
    const openApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");

    assert.equal(openApi["x-contract-id"], "C4");
    assert.equal(openApi["x-owner"], "SVC-AI");
    assert.equal(openApi.servers[0].url, "/api/v1");
    assert.ok(openApi.paths["/ai/assistant:suggest"].post);
    assert.ok(openApi.paths["/ai/onboarding:command"].post);
  });

  it("links onboarding responses to the structured command JSON Schema", () => {
    const openApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const commandSchemaRef =
      openApi.components.schemas.OnboardingCommandResponse.properties.command.$ref;

    assert.equal(
      commandSchemaRef,
      "../../json-schema/c4-ai-onboarding-command.schema.json",
    );
  });

  it("publishes Stage 4 generated/fallback C4 attribution enums", () => {
    const openApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const assistantSchema = readJson(
      "packages/contracts/json-schema/c4-ai-assistant-suggest-response.schema.json",
    );
    const onboardingSchema = readJson(
      "packages/contracts/json-schema/c4-ai-onboarding-command.schema.json",
    );

    assert.deepEqual(
      assistantSchema.properties.suggestion.properties.mode.enum,
      ["generated", "fallback"],
    );
    assert.deepEqual(
      openApi.components.schemas.AssistantSuggestion.properties.mode.enum,
      ["generated", "fallback"],
    );
    assert.deepEqual(
      onboardingSchema.properties.source.properties.generated_by.enum,
      ["generated", "fallback"],
    );
  });
});
