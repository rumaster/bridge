import {
  C4_VERSION,
  createAiOnboardingCommand,
  validateAiOnboardingCommand,
} from "../../../packages/contracts/src/c4.mjs";
import {
  assertAssistantSuggestRequest,
  assertOnboardingCommandRequest,
} from "./c4-dto.mjs";

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

      const commandDraft = classifyOnboardingPrompt(request);
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

function classifyOnboardingPrompt(request) {
  const normalizedPrompt = normalizeText(request.prompt);

  if (normalizedPrompt.includes("telegram") || normalizedPrompt.includes("телеграм")) {
    return {
      action: "channel.connect",
      params: {
        channel_type: "telegram",
        display_name: "Telegram",
        mode: "mock",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate administrator permissions and channel credentials before applying.",
      ],
    };
  }

  if (
    normalizedPrompt.includes("часовой пояс") ||
    normalizedPrompt.includes("timezone") ||
    normalizedPrompt.includes("europe/moscow")
  ) {
    return {
      action: "configuration.upsert",
      params: {
        key: "organization.timezone",
        value: extractTimezone(request.prompt),
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate the configuration key, value format and organization scope.",
      ],
    };
  }

  if (normalizedPrompt.includes("пригласи") || normalizedPrompt.includes("invite")) {
    return {
      action: "user.invite",
      params: {
        role: "manager",
        delivery: "manual",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate role assignment and invitation target before applying.",
      ],
    };
  }

  if (normalizedPrompt.includes("название") || normalizedPrompt.includes("name")) {
    return {
      action: "organization.update_profile",
      params: {
        display_name: "M0 Mock Organization",
      },
      requiresConfirmation: true,
      notes: [
        "Backend must validate organization profile fields before applying.",
      ],
    };
  }

  return {
    action: "noop",
    params: {
      reason: "unsupported_m0_prompt",
    },
    requiresConfirmation: false,
    notes: [
      "M0 deterministic mock could not map the prompt to a supported Backend operation.",
    ],
  };
}

function extractTimezone(prompt) {
  const match = prompt.match(/[A-Za-z]+\/[A-Za-z_]+/);
  return match ? match[0] : "Europe/Moscow";
}

function normalizeText(value) {
  return value.trim().toLowerCase();
}
