import { C4_VERSION } from "../../../packages/contracts/src/c4.js";

const ASSISTANT_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "conversation_id",
  "requester_user_id",
  "query",
  "context",
]);

const ONBOARDING_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "actor_user_id",
  "prompt",
  "context",
]);

/**
 * Сырой вызов LLM для узла «LLM» контракта Workflow 2.0 (добавлен 2026-07-15).
 * Ни `query`, ни `context`: базы знаний здесь нет, промпт задаёт схема целиком.
 */
const LLM_COMPLETION_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "prompt",
  "params",
]);

const MESSAGE_CONTEXT_FIELDS = new Set([
  "message_id",
  "sender_type",
  "text",
  "occurred_at",
]);

const SENDER_TYPES = new Set(["client", "manager", "system", "ai"]);

/** Единичное нарушение валидации DTO C4. */
export interface C4ValidationIssue {
  field: string;
  message: string;
}

export class C4DtoValidationError extends Error {
  readonly errors: C4ValidationIssue[];

  constructor(errors: C4ValidationIssue[]) {
    super(`C4 DTO validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "C4DtoValidationError";
    this.errors = errors;
  }
}

export function validateAssistantSuggestRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, ASSISTANT_FIELDS);
  expectConst(errors, input.contract, "C4.AssistantSuggestRequest", "contract");
  expectConst(errors, input.version, C4_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectOptionalNonEmptyString(errors, input.conversation_id, "conversation_id");
  expectOptionalNonEmptyString(errors, input.requester_user_id, "requester_user_id");
  expectNonEmptyString(errors, input.query, "query");

  if (Object.hasOwn(input, "context")) {
    validateAssistantContext(errors, input.context);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      ...input,
      query: input.query.trim(),
      context: normalizeAssistantContext(input.context),
    },
  };
}

export function validateOnboardingCommandRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, ONBOARDING_FIELDS);
  expectConst(errors, input.contract, "C4.OnboardingCommandRequest", "contract");
  expectConst(errors, input.version, C4_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.actor_user_id, "actor_user_id");
  expectNonEmptyString(errors, input.prompt, "prompt");

  if (Object.hasOwn(input, "context") && !isRecord(input.context)) {
    errors.push({
      field: "context",
      message: "context must be an object when provided.",
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      ...input,
      prompt: input.prompt.trim(),
      context: input.context ?? {},
    },
  };
}

export function validateLlmCompletionRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, LLM_COMPLETION_FIELDS);
  expectConst(errors, input.contract, "C4.LlmCompletionRequest", "contract");
  expectConst(errors, input.version, C4_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.prompt, "prompt");

  if (Object.hasOwn(input, "params") && input.params !== null && !isRecord(input.params)) {
    errors.push({
      field: "params",
      message: "params must be an object when provided.",
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      ...input,
      prompt: input.prompt.trim(),
      params: isRecord(input.params) ? input.params : {},
    },
  };
}

export function assertLlmCompletionRequest(input) {
  const result = validateLlmCompletionRequest(input);
  if (!result.ok) {
    throw new C4DtoValidationError(result.errors);
  }
  return result.value;
}

export function assertAssistantSuggestRequest(input) {
  const result = validateAssistantSuggestRequest(input);
  if (!result.ok) {
    throw new C4DtoValidationError(result.errors);
  }
  return result.value;
}

export function assertOnboardingCommandRequest(input) {
  const result = validateOnboardingCommandRequest(input);
  if (!result.ok) {
    throw new C4DtoValidationError(result.errors);
  }
  return result.value;
}

function validateAssistantContext(errors, context) {
  if (!isRecord(context)) {
    errors.push({
      field: "context",
      message: "context must be an object when provided.",
    });
    return;
  }

  rejectUnknownFields(errors, context, new Set(["messages"]), "context");

  if (!Object.hasOwn(context, "messages")) {
    return;
  }

  if (!Array.isArray(context.messages)) {
    errors.push({
      field: "context.messages",
      message: "context.messages must be an array.",
    });
    return;
  }

  context.messages.forEach((message, index) => {
    validateMessageContext(errors, message, `context.messages[${index}]`);
  });
}

function validateMessageContext(errors, message, path) {
  if (!isRecord(message)) {
    errors.push({
      field: path,
      message: "message context item must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, message, MESSAGE_CONTEXT_FIELDS, path);
  expectNonEmptyString(errors, message.message_id, `${path}.message_id`);
  expectNonEmptyString(errors, message.sender_type, `${path}.sender_type`);
  expectString(errors, message.text, `${path}.text`);
  expectNonEmptyString(errors, message.occurred_at, `${path}.occurred_at`);

  if (
    typeof message.sender_type === "string" &&
    !SENDER_TYPES.has(message.sender_type)
  ) {
    errors.push({
      field: `${path}.sender_type`,
      message: "sender_type must be one of client, manager, system or ai.",
    });
  }

  if (
    typeof message.occurred_at === "string" &&
    Number.isNaN(Date.parse(message.occurred_at))
  ) {
    errors.push({
      field: `${path}.occurred_at`,
      message: "occurred_at must be an ISO-8601 date-time.",
    });
  }
}

function normalizeAssistantContext(context) {
  if (!isRecord(context)) {
    return {
      messages: [],
    };
  }

  return {
    messages: Array.isArray(context.messages) ? context.messages : [],
  };
}

function rejectUnknownFields(errors, input, allowedFields, prefix = "") {
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      errors.push({
        field: prefix ? `${prefix}.${field}` : field,
        message: "Unexpected field.",
      });
    }
  }
}

function expectConst(errors, value, expected, field) {
  if (value !== expected) {
    errors.push({
      field,
      message: `Field must equal ${JSON.stringify(expected)}.`,
    });
  }
}

function expectNonEmptyString(errors, value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({
      field,
      message: "Field must be a non-empty string.",
    });
  }
}

function expectOptionalNonEmptyString(errors, value, field) {
  if (value !== undefined) {
    expectNonEmptyString(errors, value, field);
  }
}

function expectString(errors, value, field) {
  if (typeof value !== "string") {
    errors.push({
      field,
      message: "Field must be a string.",
    });
  }
}

function invalidPayload() {
  return {
    ok: false,
    errors: [
      {
        field: "$",
        message: "Payload must be a JSON object.",
      },
    ],
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
