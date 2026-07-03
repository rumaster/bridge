import {
  C4_VERSION,
  createAiOnboardingCommand,
  validateAiOnboardingCommand,
} from "../../../packages/contracts/src/c4.mjs";

import { assertOnboardingCommandRequest } from "./c4-dto.mjs";
import { createDeterministicMockLlm } from "./llm.mjs";
import {
  buildOnboardingPrompt,
  validateOnboardingDraft,
} from "./onboarding-pipeline.mjs";

/**
 * AI Onboarding commander (CP-5, ТЗ §12.4, §12.6).
 *
 * Flow: validate the C4 request → build a **tenant-isolated** prompt → ask the
 * swappable LLM to interpret it into a *draft* command → run the SVC-AI **first
 * barrier** (draft names a sanctioned §12.6 action) → assemble the C4 command
 * with `organization_id` pinned to the authenticated tenant → validate it
 * against the frozen §12.6 JSON-Schema. The result is a *description* only: the
 * final validation, authorization and application happen on Backend (ТЗ §13.13).
 *
 * SVC-AI has no database access and never applies changes. If the LLM is
 * unavailable the commander degrades to a safe `noop` command so onboarding UIs
 * stay responsive and the platform keeps working without AI (ТЗ §5.4).
 */
export function createOnboardingCommander({
  llm = createDeterministicMockLlm(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!llm || typeof llm.interpretOnboarding !== "function") {
    throw new TypeError(
      "createOnboardingCommander requires an llm with an interpretOnboarding() method",
    );
  }

  const metrics = {
    onboarding_command_total: 0,
    onboarding_command_degraded_total: 0,
    onboarding_command_rejected_total: 0,
  };

  async function createOnboardingCommand(payload) {
    const request = assertOnboardingCommandRequest(payload);
    metrics.onboarding_command_total += 1;

    // Tenant isolation lives in the prompt itself: the model only ever sees its
    // own organization and the sanctioned action catalogue (ТЗ §22.6, §12.6).
    const prompt = buildOnboardingPrompt({
      prompt: request.prompt,
      organizationId: request.organization_id,
    });

    let draft;
    try {
      draft = await llm.interpretOnboarding({
        prompt: prompt.prompt,
        organizationId: prompt.organization_id,
        actions: prompt.actions,
      });
    } catch (error) {
      metrics.onboarding_command_degraded_total += 1;
      return buildResponse(request, buildFallbackCommand(request, error, now));
    }

    // First barrier: reject anything that is not a sanctioned §12.6 action
    // before a C4 command is ever assembled (ТЗ §12.6).
    const draftValidation = validateOnboardingDraft(draft);
    if (!draftValidation.valid) {
      metrics.onboarding_command_rejected_total += 1;
      throw new OnboardingCommandRejectedError(draftValidation.errors);
    }

    const command = createAiOnboardingCommand({
      requestId: request.request_id,
      // organization_id is pinned to the request tenant, never taken from the
      // model, so a command can only ever target its own organization.
      organizationId: request.organization_id,
      action: draft.action,
      params: isRecord(draft.params) ? draft.params : {},
      prompt: request.prompt,
      now,
      requiresConfirmation: draft.requiresConfirmation ?? true,
      notes: Array.isArray(draft.notes) ? draft.notes : undefined,
    });

    // Second SVC-AI barrier: the assembled command must satisfy the frozen
    // §12.6 JSON-Schema before it leaves the service.
    const schemaValidation = validateAiOnboardingCommand(command);
    if (!schemaValidation.valid) {
      metrics.onboarding_command_rejected_total += 1;
      throw new OnboardingCommandRejectedError(schemaValidation.errors);
    }

    return buildResponse(request, command);
  }

  return {
    createOnboardingCommand,
    getMetrics() {
      return { ...metrics };
    },
  };
}

function buildResponse(request, command) {
  return {
    contract: "C4.OnboardingCommandResponse",
    version: C4_VERSION,
    request_id: request.request_id,
    organization_id: request.organization_id,
    degraded: command.source.generated_by === "fallback",
    fallback_reason:
      command.source.generated_by === "fallback"
        ? command.params.reason ?? "unavailable"
        : null,
    command,
  };
}

function buildFallbackCommand(request, error, now) {
  return createAiOnboardingCommand({
    requestId: request.request_id,
    organizationId: request.organization_id,
    action: "noop",
    params: { reason: fallbackReasonFor(error) },
    prompt: request.prompt,
    now,
    generatedBy: "fallback",
    requiresConfirmation: false,
    notes: [
      "AI Onboarding is temporarily unavailable; Backend must keep the existing configuration unchanged.",
    ],
  });
}

function fallbackReasonFor(error) {
  if (error && error.name === "AbortError") {
    return "timeout";
  }
  if (error && error.reason === "timeout") {
    return "timeout";
  }
  return "unavailable";
}

export class OnboardingCommandRejectedError extends Error {
  constructor(errors) {
    super(`AI onboarding command rejected: ${errors.join("; ")}`);
    this.name = "OnboardingCommandRejectedError";
    this.errors = errors;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
