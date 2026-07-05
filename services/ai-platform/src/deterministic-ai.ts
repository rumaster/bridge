import {
  C4_VERSION,
  createAiOnboardingCommand,
  validateAiOnboardingCommand,
} from "../../../packages/contracts/src/c4.js";
import {
  assertAssistantSuggestRequest,
  assertOnboardingCommandRequest,
} from "./c4-dto.js";
import { interpretOnboardingPrompt } from "./llm.js";

const ASSISTANT_FIXTURES = [
  {
    keywords: ["возврат", "return", "refund"],
    text:
      "Для возврата уточните номер заказа, причину возврата и актуальные контакты клиента. " +
      "После этого передайте обращение менеджеру для проверки условий возврата.",
  },
  {
    keywords: ["доставка", "delivery", "shipping"],
    text:
      "Уточните адрес доставки, номер заказа и желаемый интервал. " +
      "Если заказ уже передан в доставку, проверьте статус в Backend перед обещанием срока.",
  },
  {
    keywords: ["оплата", "payment", "pay"],
    text:
      "Проверьте статус платежа и предложите клиенту повторить оплату только после подтверждения, " +
      "что предыдущий платеж не был успешно проведен.",
  },
];

const DEFAULT_ASSISTANT_TEXT =
  "M0 AI mock не использует реальные LLM или Knowledge Base. Ответьте клиенту вручную, " +
  "сохраняя контекст диалога и правила организации.";

export function createDeterministicAiMock({ now = () => new Date().toISOString() } = {}) {
  const metrics = {
    assistant_suggest_total: 0,
    onboarding_command_total: 0,
  };

  return {
    suggestAssistant(payload) {
      const request = assertAssistantSuggestRequest(payload);
      metrics.assistant_suggest_total += 1;

      const fixture = findAssistantFixture(request.query);

      return {
        contract: "C4.AssistantSuggestResponse",
        version: C4_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        degraded: false,
        fallback_reason: null,
        suggestion: {
          mode: "deterministic_mock",
          text: fixture.text,
          confidence: fixture.confidence,
        },
        source_status: "not_available_m0",
        sources: [],
        created_at: now(),
      };
    },

    createOnboardingCommand(payload) {
      const request = assertOnboardingCommandRequest(payload);
      metrics.onboarding_command_total += 1;

      const commandDraft = interpretOnboardingPrompt(request.prompt);
      const command = createAiOnboardingCommand({
        requestId: request.request_id,
        organizationId: request.organization_id,
        action: commandDraft.action,
        params: commandDraft.params,
        prompt: request.prompt,
        now,
        requiresConfirmation: commandDraft.requiresConfirmation,
        notes: commandDraft.notes,
      });
      const validation = validateAiOnboardingCommand(command);

      if (!validation.valid) {
        throw new Error(
          `Deterministic C4 onboarding command is invalid: ${validation.errors.join("; ")}`,
        );
      }

      return {
        contract: "C4.OnboardingCommandResponse",
        version: C4_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        degraded: false,
        fallback_reason: null,
        command,
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function findAssistantFixture(query) {
  const normalizedQuery = normalizeText(query);
  const fixture = ASSISTANT_FIXTURES.find((candidate) =>
    candidate.keywords.some((keyword) => normalizedQuery.includes(keyword)),
  );

  if (fixture) {
    return {
      text: fixture.text,
      confidence: 0.64,
    };
  }

  return {
    text: DEFAULT_ASSISTANT_TEXT,
    confidence: 0.25,
  };
}

function normalizeText(value) {
  return value.trim().toLowerCase();
}
