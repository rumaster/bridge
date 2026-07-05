import { readFileSync } from "node:fs";

export const C4_VERSION = "1.0.0";

export const AI_ONBOARDING_COMMAND_ACTIONS = Object.freeze([
  "organization.update_profile",
  "configuration.upsert",
  "channel.connect",
  "user.invite",
  "noop",
]);

export const AI_ONBOARDING_COMMAND_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../json-schema/c4-ai-onboarding-command.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const AI_ASSISTANT_SUGGEST_RESPONSE_SCHEMA = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL(
        "../json-schema/c4-ai-assistant-suggest-response.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export const AI_ASSISTANT_SOURCE_TYPES = Object.freeze(["knowledge_chunk", "none"]);

export const AI_ASSISTANT_SOURCE_STATUSES = Object.freeze([
  "available",
  "not_available_m0",
  "unavailable",
]);

/**
 * Build a frozen C4 assistant suggestion response. Used by the RAG pipeline
 * (CP-3) and by fallbacks; the shape never diverges from the M0 contract.
 */
export function createAssistantSuggestResponse({
  requestId,
  organizationId,
  suggestion,
  sources = [],
  sourceStatus,
  degraded = false,
  fallbackReason = null,
  now = () => new Date().toISOString(),
}) {
  return {
    contract: "C4.AssistantSuggestResponse",
    version: C4_VERSION,
    request_id: requestId,
    organization_id: organizationId,
    degraded,
    fallback_reason: fallbackReason,
    suggestion: {
      mode: suggestion.mode,
      text: suggestion.text,
      confidence: suggestion.confidence,
    },
    source_status: sourceStatus,
    sources,
    created_at: now(),
  };
}

export function validateAssistantSuggestResponse(response) {
  return validateJsonSchema(response, AI_ASSISTANT_SUGGEST_RESPONSE_SCHEMA);
}

export function createAiOnboardingCommand({
  requestId,
  organizationId,
  action,
  params = {},
  prompt,
  now = () => new Date().toISOString(),
  generatedBy = "deterministic-mock-ai",
  requiresConfirmation = true,
  notes = [
    "Command is a description only; Backend must validate permissions and state before applying it.",
  ],
}) {
  if (!AI_ONBOARDING_COMMAND_ACTIONS.includes(action)) {
    throw new TypeError(`Unsupported C4 AI onboarding action: ${action}`);
  }

  return {
    contract: "C4.AiOnboardingCommand",
    version: C4_VERSION,
    command_id: `${requestId}:command`,
    organization_id: organizationId,
    action,
    params,
    safety: {
      apply_mode: "backend_validation_required",
      requires_confirmation: requiresConfirmation,
      notes,
    },
    source: {
      prompt,
      generated_by: generatedBy,
    },
    created_at: now(),
  };
}

export function validateAiOnboardingCommand(command) {
  return validateJsonSchema(command, AI_ONBOARDING_COMMAND_SCHEMA);
}

/** Результат валидации по JSON-схеме (общий контракт C4). */
export interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateJsonSchema(value, schema): JsonSchemaValidationResult {
  const errors: string[] = [];
  visitJsonSchema(value, schema, "$", errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function visitJsonSchema(value, schema, path, errors) {
  if (schema === null || typeof schema !== "object") {
    return;
  }

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (schema.type && !matchesJsonType(value, schema.type)) {
    errors.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return;
  }

  if (typeof value === "string") {
    validateStringKeywords(value, schema, path, errors);
  }

  if (typeof value === "number") {
    validateNumberKeywords(value, schema, path, errors);
  }

  if (Array.isArray(value)) {
    validateArrayKeywords(value, schema, path, errors);
  }

  if (isRecord(value)) {
    validateObjectKeywords(value, schema, path, errors);
  }
}

function matchesJsonType(value, expected) {
  const expectedTypes = Array.isArray(expected) ? expected : [expected];

  return expectedTypes.some((type) => {
    if (type === "array") {
      return Array.isArray(value);
    }
    if (type === "object") {
      return isRecord(value);
    }
    if (type === "integer") {
      return Number.isInteger(value);
    }
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (type === "null") {
      return value === null;
    }
    return typeof value === type;
  });
}

function validateStringKeywords(value, schema, path, errors) {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path} length must be at least ${schema.minLength}`);
  }

  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path} length must be at most ${schema.maxLength}`);
  }

  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} must match /${schema.pattern}/`);
  }

  if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be a valid date-time`);
  }
}

function validateNumberKeywords(value, schema, path, errors) {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }

  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }
}

function validateArrayKeywords(value, schema, path, errors) {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must contain at least ${schema.minItems} items`);
  }

  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${schema.maxItems} items`);
  }

  if (schema.items) {
    value.forEach((item, index) => {
      visitJsonSchema(item, schema.items, `${path}[${index}]`, errors);
    });
  }
}

function validateObjectKeywords(value, schema, path, errors) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      errors.push(`${path}.${field} is required`);
    }
  }

  for (const [field, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, field)) {
      visitJsonSchema(value[field], propertySchema, `${path}.${field}`, errors);
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const field of Object.keys(value)) {
      if (!allowed.has(field)) {
        errors.push(`${path}.${field} is not allowed`);
      }
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
