import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../packages/contracts/src/c4.mjs";
import { createDeterministicMockLlm } from "../../services/ai-platform/src/llm.mjs";
import { ONBOARDING_ACTIONS } from "../../services/ai-platform/src/onboarding-pipeline.mjs";
import { createOnboardingCommander } from "../../services/ai-platform/src/onboarding.mjs";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/**
 * CP-5 contract stabilization: the sanctioned operations SVC-AI is willing to
 * describe must equal the enum frozen in the §12.6 structured-command JSON Schema
 * (the artifact the Backend re-validates against). This binds the runtime action
 * catalogue to the frozen contract so the two cannot drift apart.
 */
describe("C4 onboarding command — CP-5 contract stabilization", () => {
  const schema = readJson(
    "packages/contracts/json-schema/c4-ai-onboarding-command.schema.json",
  );

  it("keeps SVC-AI's sanctioned actions equal to the frozen §12.6 schema enum", () => {
    const frozenActions = schema.properties.action.enum;
    assert.deepEqual([...ONBOARDING_ACTIONS], [...frozenActions]);
  });

  it("produces a command that validates against the frozen §12.6 schema", async () => {
    const commander = createOnboardingCommander({
      llm: createDeterministicMockLlm(),
      now: () => "2026-07-03T10:00:00.000Z",
    });

    const response = await commander.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-cp5-contract",
      organization_id: "org-cp5",
      actor_user_id: "admin-1",
      prompt: "Установи часовой пояс Europe/Moscow",
    });

    assert.equal(response.command.contract, schema.properties.contract.const);
    assert.equal(response.command.safety.apply_mode, "backend_validation_required");
    assert.equal(validateAiOnboardingCommand(response.command).valid, true);
    assert.ok(
      schema.properties.action.enum.includes(response.command.action),
      "the interpreted action must be a frozen sanctioned operation",
    );
  });
});
