import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createAiOnboardingCommand,
  validateJsonSchema,
} from "../../src/c4.js";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

describe("C4 AI Onboarding structured command JSON Schema", () => {
  it("accepts a backend-validated structured command", () => {
    const schema = readJson(
      "../../json-schema/c4-ai-onboarding-command.schema.json",
    );
    const command = createAiOnboardingCommand({
      requestId: "req-onboarding-1",
      organizationId: "org-1",
      action: "configuration.upsert",
      params: {
        key: "organization.timezone",
        value: "Europe/Moscow",
      },
      prompt: "Установи часовой пояс Europe/Moscow",
      now: () => "2026-07-02T16:30:00.000Z",
    });

    const result = validateJsonSchema(command, schema);

    assert.equal(result.valid, true);
  });

  it("rejects dangerous or unknown operations", () => {
    const schema = readJson(
      "../../json-schema/c4-ai-onboarding-command.schema.json",
    );
    const command = createAiOnboardingCommand({
      requestId: "req-onboarding-1",
      organizationId: "org-1",
      action: "configuration.upsert",
      params: {
        key: "organization.timezone",
        value: "Europe/Moscow",
      },
      prompt: "Установи часовой пояс Europe/Moscow",
      now: () => "2026-07-02T16:30:00.000Z",
    });

    const result = validateJsonSchema(
      {
        ...command,
        action: "database.execute_sql",
      },
      schema,
    );

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /action/);
  });

  it("rejects commands that bypass Backend validation", () => {
    const schema = readJson(
      "../../json-schema/c4-ai-onboarding-command.schema.json",
    );
    const command = createAiOnboardingCommand({
      requestId: "req-onboarding-1",
      organizationId: "org-1",
      action: "configuration.upsert",
      params: {
        key: "organization.timezone",
        value: "Europe/Moscow",
      },
      prompt: "Установи часовой пояс Europe/Moscow",
      now: () => "2026-07-02T16:30:00.000Z",
    });

    const result = validateJsonSchema(
      {
        ...command,
        safety: {
          ...command.safety,
          apply_mode: "direct_apply",
        },
      },
      schema,
    );

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /safety\.apply_mode/);
  });
});
