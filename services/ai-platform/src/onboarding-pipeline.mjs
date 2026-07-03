import { AI_ONBOARDING_COMMAND_ACTIONS } from "../../../packages/contracts/src/c4.mjs";

/**
 * Pure AI Onboarding building blocks (ТЗ §12.4, §12.6, §22.6). These functions
 * never touch the network, the database or an LLM — they only shape the prompt
 * handed to the model and validate the draft command it proposes, so they are
 * trivially unit-testable and deterministic.
 *
 * SVC-AI never applies anything: it produces a *description* (a structured
 * command from the §12.6 catalogue) that Backend validates, authorizes and
 * applies. The pipeline's job is the SVC-AI-side **first barrier** — only
 * sanctioned actions with a well-formed shape are allowed to leave the service.
 */

/** The sanctioned §12.6 action catalogue, kept in sync with the C4 contract. */
export const ONBOARDING_ACTIONS = AI_ONBOARDING_COMMAND_ACTIONS;

const ACTION_SET = new Set(ONBOARDING_ACTIONS);

/**
 * Build the prompt handed to the LLM for onboarding. The system instruction
 * pins the request to a single organization, forbids acting on any other tenant
 * and constrains the model to the sanctioned action catalogue, so the tenant
 * boundary and the "describe only, never apply" rule are expressed in the prompt
 * itself (ТЗ §22.6, §12.6). No cross-tenant data is ever embedded.
 */
export function buildOnboardingPrompt({ prompt, organizationId }) {
  const system = [
    "Ты — помощник онбординга Bridge для одной организации.",
    `Работай строго в контексте организации ${organizationId} и только с её настройками.`,
    "Запрещено обращаться к данным или настройкам других организаций.",
    "Ты не изменяешь данные напрямую: ты описываешь одну структурированную команду,",
    "которую применит Backend после проверки полномочий и валидации.",
    `Допустимы только санкционированные операции: ${ONBOARDING_ACTIONS.join(", ")}.`,
    "Если запрос не соответствует ни одной операции — верни noop.",
  ].join(" ");

  return {
    system,
    organization_id: organizationId,
    actions: [...ONBOARDING_ACTIONS],
    prompt,
  };
}

/**
 * Validate the draft command the LLM proposed — the SVC-AI first barrier. A
 * draft is accepted only when it names a sanctioned §12.6 action and carries an
 * object `params` bag; anything else (unknown/forbidden action, missing action,
 * non-object params) is rejected before a C4 command is ever assembled.
 */
export function validateOnboardingDraft(draft) {
  const errors = [];

  if (!isRecord(draft)) {
    return { valid: false, errors: ["draft must be an object"] };
  }

  if (typeof draft.action !== "string" || draft.action.trim() === "") {
    errors.push("draft.action must be a non-empty string");
  } else if (!ACTION_SET.has(draft.action)) {
    errors.push(
      `draft.action '${draft.action}' is not a sanctioned §12.6 operation (allowed: ${ONBOARDING_ACTIONS.join(", ")})`,
    );
  }

  if (Object.hasOwn(draft, "params") && !isRecord(draft.params)) {
    errors.push("draft.params must be an object when provided");
  }

  return { valid: errors.length === 0, errors };
}

/** Whether `action` is one of the sanctioned §12.6 operations. */
export function isSanctionedAction(action) {
  return ACTION_SET.has(action);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
