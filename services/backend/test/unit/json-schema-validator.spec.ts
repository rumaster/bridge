import { validateJsonSchema } from "../../src/common/json-schema/json-schema-validator";
import { AI_ONBOARDING_COMMAND_SCHEMA } from "../../src/modules/ai-integration/ai-onboarding-command.schema";

function validCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "C4.AiOnboardingCommand",
    version: "1.0.0",
    command_id: "req-1:command",
    organization_id: "00000000-0000-4000-8000-000000000101",
    action: "configuration.upsert",
    params: { value: { locale: "ru-RU" } },
    safety: {
      apply_mode: "backend_validation_required",
      requires_confirmation: false,
      notes: ["ok"],
    },
    source: {
      prompt: "Set locale to ru-RU",
      generated_by: "deterministic-mock-ai",
    },
    created_at: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("validateJsonSchema against the C4 §12.6 command schema", () => {
  it("accepts a well-formed structured command", () => {
    const result = validateJsonSchema(validCommand(), AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects an unknown action outside the frozen enum", () => {
    const result = validateJsonSchema(validCommand({ action: "database.drop" }), AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("$.action must be one of"))).toBe(true);
  });

  it("rejects a wrong contract discriminator", () => {
    const result = validateJsonSchema(validCommand({ contract: "C4.Other" }), AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('$.contract must equal "C4.AiOnboardingCommand"');
  });

  it("rejects additional top-level properties", () => {
    const result = validateJsonSchema(validCommand({ injected: true }), AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("$.injected is not allowed");
  });

  it("rejects a missing required safety block", () => {
    const command = validCommand();
    delete command.safety;
    const result = validateJsonSchema(command, AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("$.safety is required");
  });

  it("rejects a non date-time created_at", () => {
    const result = validateJsonSchema(validCommand({ created_at: "not-a-date" }), AI_ONBOARDING_COMMAND_SCHEMA);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("$.created_at must be a valid date-time");
  });
});
