import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeterministicAiMock } from "../../src/deterministic-ai.js";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("deterministic AI mock", () => {
  it("returns a stable assistant suggestion for the same fixed input", () => {
    const ai = createDeterministicAiMock({ now: fixedNow });
    const payload = {
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      query: "Как оформить возврат?",
      context: { messages: [] },
    };

    const first = ai.suggestAssistant(payload);
    const second = ai.suggestAssistant(payload);

    assert.deepEqual(first, second);
    assert.equal(first.contract, "C4.AssistantSuggestResponse");
    assert.equal(first.suggestion.mode, "generated");
    assert.match(first.suggestion.text, /возврат/i);
    assert.equal(first.source_status, "not_available_m0");
  });

  it("returns a structured onboarding command that backend must validate before applying", () => {
    const ai = createDeterministicAiMock({ now: fixedNow });

    const response: any = ai.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-onboarding-1",
      organization_id: "org-1",
      actor_user_id: "admin-1",
      prompt: "Установи часовой пояс Europe/Moscow",
      context: {},
    });

    assert.equal(response.contract, "C4.OnboardingCommandResponse");
    assert.equal(response.command.contract, "C4.AiOnboardingCommand");
    assert.equal(response.command.action, "configuration.upsert");
    assert.equal(response.command.params.key, "organization.timezone");
    assert.equal(response.command.safety.apply_mode, "backend_validation_required");
  });
});
