import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateAssistantSuggestRequest,
  validateOnboardingCommandRequest,
} from "../../src/c4-dto.mjs";

describe("C4 AI DTO validators", () => {
  it("accepts the frozen assistant suggest request DTO", () => {
    const result = validateAssistantSuggestRequest({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      requester_user_id: "manager-1",
      query: "Как оформить возврат?",
      context: {
        messages: [
          {
            message_id: "message-1",
            sender_type: "client",
            text: "Хочу вернуть заказ",
            occurred_at: "2026-07-02T16:30:00.000Z",
          },
        ],
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.query, "Как оформить возврат?");
  });

  it("rejects assistant requests with unknown fields", () => {
    const result = validateAssistantSuggestRequest({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      query: "Подскажи ответ",
      sql: "drop table organizations",
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /sql/);
  });

  it("accepts the frozen onboarding command request DTO", () => {
    const result = validateOnboardingCommandRequest({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-onboarding-1",
      organization_id: "org-1",
      actor_user_id: "admin-1",
      prompt: "Установи часовой пояс Europe/Moscow",
      context: {
        locale: "ru-RU",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.prompt, "Установи часовой пояс Europe/Moscow");
  });

  it("rejects onboarding requests without an organization", () => {
    const result = validateOnboardingCommandRequest({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-onboarding-1",
      actor_user_id: "admin-1",
      prompt: "Настрой организацию",
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /organization_id/);
  });
});
