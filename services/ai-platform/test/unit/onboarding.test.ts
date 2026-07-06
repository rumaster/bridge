import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../../../packages/contracts/src/c4.js";
import { createDeterministicMockLlm, createUnavailableLlm } from "../../src/llm.js";
import {
  OnboardingCommandRejectedError,
  createOnboardingCommander,
} from "../../src/onboarding.js";

const fixedNow = () => "2026-07-03T10:00:00.000Z";
const ORG_A = "org-a";
const ORG_B = "org-b";

function request(overrides = {}) {
  return {
    contract: "C4.OnboardingCommandRequest",
    version: "1.0.0",
    request_id: "req-onboarding-1",
    organization_id: ORG_A,
    actor_user_id: "admin-1",
    prompt: "Установи часовой пояс Europe/Moscow",
    context: {},
    ...overrides,
  };
}

describe("onboarding commander — sanctioned commands", () => {
  it("interprets a NL request into a valid §12.6 command via the swappable LLM", async () => {
    const commander = createOnboardingCommander({
      llm: createDeterministicMockLlm(),
      now: fixedNow,
    });

    const response = await commander.createOnboardingCommand(request());

    assert.equal(response.contract, "C4.OnboardingCommandResponse");
    assert.equal(response.degraded, false);
    assert.equal(response.command.action, "configuration.upsert");
    assert.equal(response.command.params.key, "organization.timezone");
    assert.equal(response.command.params.value, "Europe/Moscow");
    assert.equal(response.command.safety.apply_mode, "backend_validation_required");
    assert.equal(response.command.source.generated_by, "deterministic-mock-ai");
    // The exact validation the Backend re-runs before applying (first barrier).
    assert.equal(validateAiOnboardingCommand(response.command).valid, true);
  });

  it("is deterministic — same request in, same command out", async () => {
    const commander = createOnboardingCommander({ now: fixedNow });
    const first = await commander.createOnboardingCommand(request());
    const second = await commander.createOnboardingCommand(request());
    assert.deepEqual(first, second);
  });

  it("pins organization_id to the request tenant, never to the model output", async () => {
    // A rogue LLM tries to target another organization; the commander must ignore it.
    const rogueLlm = {
      async interpretOnboarding() {
        return {
          action: "configuration.upsert",
          params: { key: "organization.timezone", value: "Europe/Moscow" },
          organization_id: ORG_B,
        };
      },
    };
    const commander = createOnboardingCommander({ llm: rogueLlm, now: fixedNow });

    const response = await commander.createOnboardingCommand(request({ organization_id: ORG_A }));

    assert.equal(response.organization_id, ORG_A);
    assert.equal(response.command.organization_id, ORG_A);
  });
});

describe("onboarding commander — first barrier rejection", () => {
  it("rejects an unsanctioned action the LLM proposes", async () => {
    const rogueLlm = {
      async interpretOnboarding() {
        return { action: "database.drop", params: {} };
      },
    };
    const commander = createOnboardingCommander({ llm: rogueLlm, now: fixedNow });

    await assert.rejects(
      () => commander.createOnboardingCommand(request()),
      (error) => {
        assert.ok(error instanceof OnboardingCommandRejectedError);
        assert.match(error.message, /not a sanctioned/);
        return true;
      },
    );
    assert.equal(commander.getMetrics().onboarding_command_rejected_total, 1);
  });

  it("rejects a malformed C4 request before ever calling the LLM", async () => {
    let called = false;
    const spyLlm = {
      async interpretOnboarding() {
        called = true;
        return { action: "noop", params: {} };
      },
    };
    const commander = createOnboardingCommander({ llm: spyLlm, now: fixedNow });

    await assert.rejects(() =>
      commander.createOnboardingCommand(request({ prompt: "" })),
    );
    assert.equal(called, false, "LLM must not be called for an invalid request");
  });
});

describe("onboarding commander — degradation", () => {
  it("degrades to a safe noop command when the LLM is unavailable", async () => {
    const commander = createOnboardingCommander({
      llm: createUnavailableLlm(),
      now: fixedNow,
    });

    const response = await commander.createOnboardingCommand(request());

    assert.equal(response.degraded, true);
    assert.equal(response.fallback_reason, "unavailable");
    assert.equal(response.command.action, "noop");
    assert.equal(response.command.source.generated_by, "fallback");
    assert.equal(response.command.organization_id, ORG_A);
    assert.equal(validateAiOnboardingCommand(response.command).valid, true);
    assert.equal(commander.getMetrics().onboarding_command_degraded_total, 1);
  });
});
