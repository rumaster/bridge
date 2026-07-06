import { AiIntegrationFacade } from "../../src/modules/ai-integration/ai-integration.facade";
import type { AiAssistantFacadeResponse } from "../../src/modules/ai-integration/ai-integration.facade";
import type { AiUpstreamClient } from "../../src/modules/ai-integration/ai-integration.upstream";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("AiIntegrationFacade", () => {
  it("passes through a successful AI assistant response", async () => {
    const facade = new AiIntegrationFacade();
    const response: AiAssistantFacadeResponse = {
      contract: "C4.AssistantSuggestResponse",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      degraded: false,
      fallback_reason: null,
      suggestion: {
        mode: "deterministic_mock",
        text: "mock response",
        confidence: 0.64,
      },
      source_status: "not_available_m0",
      sources: [],
      created_at: "2026-07-02T16:30:00.000Z",
    };

    await expect(
      facade.suggestAssistant(
        {
          request_id: "req-assistant-1",
          organization_id: "org-1",
          query: "Как оформить возврат?",
        },
        {
          call: async () => response,
          now: fixedNow,
        },
      ),
    ).resolves.toBe(response);
  });

  it("uses the injected upstream by default when it is configured", async () => {
    const response: AiAssistantFacadeResponse = {
      contract: "C4.AssistantSuggestResponse",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      degraded: false,
      fallback_reason: null,
      suggestion: {
        mode: "deterministic_mock",
        text: "grpc response",
        confidence: 0.64,
      },
      source_status: "available",
      sources: [],
      created_at: "2026-07-02T16:30:00.000Z",
    };
    const upstream: AiUpstreamClient = {
      createOnboardingCommand: jest.fn(),
      suggestAssistant: jest.fn().mockResolvedValue(response),
    };
    const facade = new AiIntegrationFacade({}, upstream);

    expect(facade.getStatus()).toMatchObject({
      mode: "grpc",
      status: "available",
    });
    await expect(
      facade.suggestAssistant({
        request_id: "req-assistant-1",
        organization_id: "org-1",
        query: "Как оформить возврат?",
      }),
    ).resolves.toBe(response);
    expect(upstream.suggestAssistant).toHaveBeenCalledWith({
      request_id: "req-assistant-1",
      organization_id: "org-1",
      query: "Как оформить возврат?",
    });
  });

  it("returns controlled unavailable fallback when AI has no callable client", async () => {
    const facade = new AiIntegrationFacade();

    await expect(
      facade.suggestAssistant(
        {
          request_id: "req-assistant-1",
          organization_id: "org-1",
          query: "Как оформить возврат?",
        },
        { now: fixedNow },
      ),
    ).resolves.toMatchObject({
      degraded: true,
      fallback_reason: "unavailable",
      suggestion: {
        mode: "fallback",
        confidence: 0,
      },
      source_status: "unavailable",
      sources: [],
      created_at: "2026-07-02T16:30:00.000Z",
    });
  });

  it("returns controlled timeout fallback when AI call exceeds the facade limit", async () => {
    const facade = new AiIntegrationFacade();

    await expect(
      facade.createOnboardingCommand(
        {
          request_id: "req-onboarding-1",
          organization_id: "org-1",
          prompt: "Установи часовой пояс Europe/Moscow",
        },
        {
          call: () => new Promise(() => undefined),
          timeoutMs: 1,
          now: fixedNow,
        },
      ),
    ).resolves.toMatchObject({
      degraded: true,
      fallback_reason: "timeout",
      command: {
        action: "noop",
        params: {
          reason: "ai_timeout",
        },
        safety: {
          apply_mode: "backend_validation_required",
          requires_confirmation: false,
        },
      },
    });
  });
});
