import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AI_ONBOARDING_COMMAND_ACTIONS } from "../../../../packages/contracts/src/c4.js";
import {
  ONBOARDING_ACTIONS,
  buildOnboardingPrompt,
  isSanctionedAction,
  validateOnboardingDraft,
} from "../../src/onboarding-pipeline.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("onboarding pipeline — tenant-isolated prompt", () => {
  it("pins the prompt to a single organization and forbids other tenants", () => {
    const prompt = buildOnboardingPrompt({
      prompt: "Установи часовой пояс Europe/Moscow",
      organizationId: ORG_A,
    });

    assert.equal(prompt.organization_id, ORG_A);
    assert.match(prompt.system, new RegExp(ORG_A));
    assert.match(prompt.system, /других организаций/);
    assert.doesNotMatch(prompt.system, new RegExp(ORG_B));
  });

  it("expresses the 'describe only, never apply' rule and the action catalogue", () => {
    const prompt = buildOnboardingPrompt({ prompt: "любой запрос", organizationId: ORG_A });

    assert.match(prompt.system, /не изменяешь данные напрямую/);
    assert.deepEqual(prompt.actions, [...AI_ONBOARDING_COMMAND_ACTIONS]);
    for (const action of AI_ONBOARDING_COMMAND_ACTIONS) {
      assert.ok(prompt.system.includes(action), `system prompt must list ${action}`);
    }
  });

  it("carries the same catalogue as the frozen C4 contract", () => {
    assert.deepEqual([...ONBOARDING_ACTIONS], [...AI_ONBOARDING_COMMAND_ACTIONS]);
  });
});

describe("onboarding pipeline — draft first barrier", () => {
  it("accepts a sanctioned §12.6 action", () => {
    const result = validateOnboardingDraft({
      action: "configuration.upsert",
      params: { key: "organization.timezone", value: "Europe/Moscow" },
    });
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("accepts every sanctioned action in the catalogue", () => {
    for (const action of AI_ONBOARDING_COMMAND_ACTIONS) {
      assert.equal(isSanctionedAction(action), true);
      assert.equal(validateOnboardingDraft({ action, params: {} }).valid, true);
    }
  });

  it("rejects an unsanctioned/forbidden action", () => {
    const result = validateOnboardingDraft({ action: "database.drop", params: {} });
    assert.equal(result.valid, false);
    assert.equal(isSanctionedAction("database.drop"), false);
    assert.match(result.errors.join("; "), /not a sanctioned/);
  });

  it("rejects a missing action and a non-object params bag", () => {
    assert.equal(validateOnboardingDraft({ params: {} }).valid, false);
    assert.equal(validateOnboardingDraft({ action: "noop", params: [] }).valid, false);
    assert.equal(validateOnboardingDraft(null).valid, false);
  });
});
