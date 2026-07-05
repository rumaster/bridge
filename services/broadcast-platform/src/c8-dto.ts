import { BROADCAST_STATUSES, C8_VERSION } from "../../../packages/contracts/src/c8.js";

const CREATE_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "created_by",
  "name",
  "template",
  "filter",
  "schedule",
  "rate_limit",
]);

const START_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "started_by",
  "mode",
  "scheduled_for",
  "idempotency_key",
]);

const STATS_RESPONSE_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "broadcast_id",
  "status",
  "stats",
]);

const TEMPLATE_FIELDS = new Set(["type", "body", "locale", "variables"]);
const FILTER_FIELDS = new Set(["mode", "channels", "tags", "segment_ids", "criteria"]);
const SCHEDULE_FIELDS = new Set(["mode", "scheduled_for", "timezone", "trigger"]);
const RATE_LIMIT_FIELDS = new Set(["messages_per_minute", "burst", "strategy"]);
const STATS_FIELDS = new Set(["prepared", "sent", "delivered", "failed", "updated_at"]);

const TEMPLATE_TYPES = new Set(["text"]);
const FILTER_MODES = new Set(["all", "tags", "segment", "custom"]);
const SCHEDULE_MODES = new Set(["manual", "immediate", "scheduled", "event", "workflow"]);
const START_MODES = new Set(["immediate", "scheduled"]);
const RATE_LIMIT_STRATEGIES = new Set(["fixed", "channel_capability"]);
const BROADCAST_STATUS_SET = new Set(BROADCAST_STATUSES);

export class C8DtoValidationError extends Error {
  constructor(errors) {
    super(`C8 DTO validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "C8DtoValidationError";
    this.errors = errors;
  }
}

export function validateCreateBroadcastRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, CREATE_FIELDS);
  expectConst(errors, input.contract, "C8.CreateBroadcastRequest", "contract");
  expectConst(errors, input.version, C8_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.created_by, "created_by");
  expectNonEmptyString(errors, input.name, "name");
  validateTemplate(errors, input.template);
  validateFilter(errors, input.filter);
  validateSchedule(errors, input.schedule);
  validateRateLimit(errors, input.rate_limit);

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
      name: input.name.trim(),
      template: normalizeTemplate(input.template),
      filter: normalizeFilter(input.filter),
      schedule: normalizeSchedule(input.schedule),
      rate_limit: normalizeRateLimit(input.rate_limit),
    },
  };
}

export function validateStartBroadcastRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, START_FIELDS);
  expectConst(errors, input.contract, "C8.StartBroadcastRequest", "contract");
  expectConst(errors, input.version, C8_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.started_by, "started_by");
  expectNonEmptyString(errors, input.mode, "mode");

  if (typeof input.mode === "string" && !START_MODES.has(input.mode)) {
    errors.push({
      field: "mode",
      message: "mode must be immediate or scheduled.",
    });
  }

  if (input.mode === "scheduled") {
    expectIsoDateTime(errors, input.scheduled_for, "scheduled_for");
  } else {
    expectOptionalIsoDateTime(errors, input.scheduled_for, "scheduled_for");
  }

  expectOptionalNonEmptyString(errors, input.idempotency_key, "idempotency_key");

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
      mode: input.mode,
      idempotency_key: input.idempotency_key ?? input.request_id,
    },
  };
}

export function validateBroadcastStatsResponse(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, STATS_RESPONSE_FIELDS);
  expectConst(errors, input.contract, "C8.BroadcastStatsResponse", "contract");
  expectConst(errors, input.version, C8_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.broadcast_id, "broadcast_id");
  expectNonEmptyString(errors, input.status, "status");

  if (typeof input.status === "string" && !BROADCAST_STATUS_SET.has(input.status)) {
    errors.push({
      field: "status",
      message: `status must be one of ${BROADCAST_STATUSES.join(", ")}.`,
    });
  }

  validateStats(errors, input.stats);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: input,
  };
}

export function assertCreateBroadcastRequest(input) {
  const result = validateCreateBroadcastRequest(input);
  if (!result.ok) {
    throw new C8DtoValidationError(result.errors);
  }
  return result.value;
}

export function assertStartBroadcastRequest(input) {
  const result = validateStartBroadcastRequest(input);
  if (!result.ok) {
    throw new C8DtoValidationError(result.errors);
  }
  return result.value;
}

export function assertBroadcastStatsResponse(input) {
  const result = validateBroadcastStatsResponse(input);
  if (!result.ok) {
    throw new C8DtoValidationError(result.errors);
  }
  return result.value;
}

function validateTemplate(errors, template) {
  if (!isRecord(template)) {
    errors.push({
      field: "template",
      message: "template must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, template, TEMPLATE_FIELDS, "template");
  expectNonEmptyString(errors, template.type, "template.type");
  expectNonEmptyString(errors, template.body, "template.body");
  expectOptionalNonEmptyString(errors, template.locale, "template.locale");

  if (typeof template.type === "string" && !TEMPLATE_TYPES.has(template.type)) {
    errors.push({
      field: "template.type",
      message: "template.type must be text in C8 v1 M0.",
    });
  }

  if (Object.hasOwn(template, "variables")) {
    validateStringArray(errors, template.variables, "template.variables");
  }
}

function validateFilter(errors, filter) {
  if (!isRecord(filter)) {
    errors.push({
      field: "filter",
      message: "filter must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, filter, FILTER_FIELDS, "filter");
  expectNonEmptyString(errors, filter.mode, "filter.mode");

  if (typeof filter.mode === "string" && !FILTER_MODES.has(filter.mode)) {
    errors.push({
      field: "filter.mode",
      message: "filter.mode must be all, tags, segment or custom.",
    });
  }

  for (const field of ["channels", "tags", "segment_ids"]) {
    if (Object.hasOwn(filter, field)) {
      validateStringArray(errors, filter[field], `filter.${field}`);
    }
  }

  if (Object.hasOwn(filter, "criteria") && !isRecord(filter.criteria)) {
    errors.push({
      field: "filter.criteria",
      message: "filter.criteria must be an object when provided.",
    });
  }
}

function validateSchedule(errors, schedule) {
  if (!isRecord(schedule)) {
    errors.push({
      field: "schedule",
      message: "schedule must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, schedule, SCHEDULE_FIELDS, "schedule");
  expectNonEmptyString(errors, schedule.mode, "schedule.mode");

  if (typeof schedule.mode === "string" && !SCHEDULE_MODES.has(schedule.mode)) {
    errors.push({
      field: "schedule.mode",
      message: "schedule.mode must be manual, immediate, scheduled, event or workflow.",
    });
  }

  if (schedule.mode === "scheduled") {
    expectIsoDateTime(errors, schedule.scheduled_for, "schedule.scheduled_for");
  } else {
    expectOptionalIsoDateTime(errors, schedule.scheduled_for, "schedule.scheduled_for");
  }

  expectOptionalNonEmptyString(errors, schedule.timezone, "schedule.timezone");
  expectOptionalNonEmptyString(errors, schedule.trigger, "schedule.trigger");
}

function validateRateLimit(errors, rateLimit) {
  if (!isRecord(rateLimit)) {
    errors.push({
      field: "rate_limit",
      message: "rate_limit must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, rateLimit, RATE_LIMIT_FIELDS, "rate_limit");
  expectPositiveInteger(errors, rateLimit.messages_per_minute, "rate_limit.messages_per_minute");

  if (Object.hasOwn(rateLimit, "burst")) {
    expectPositiveInteger(errors, rateLimit.burst, "rate_limit.burst");
  }

  if (
    typeof rateLimit.strategy === "string" &&
    !RATE_LIMIT_STRATEGIES.has(rateLimit.strategy)
  ) {
    errors.push({
      field: "rate_limit.strategy",
      message: "rate_limit.strategy must be fixed or channel_capability.",
    });
  }

  expectOptionalNonEmptyString(errors, rateLimit.strategy, "rate_limit.strategy");
}

function validateStats(errors, stats) {
  if (!isRecord(stats)) {
    errors.push({
      field: "stats",
      message: "stats must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, stats, STATS_FIELDS, "stats");

  for (const field of ["prepared", "sent", "delivered", "failed"]) {
    expectNonNegativeInteger(errors, stats[field], `stats.${field}`);
  }

  expectIsoDateTime(errors, stats.updated_at, "stats.updated_at");

  if (
    Number.isInteger(stats.sent) &&
    Number.isInteger(stats.prepared) &&
    stats.sent > stats.prepared
  ) {
    errors.push({
      field: "stats.sent",
      message: "stats.sent must not exceed stats.prepared.",
    });
  }

  if (
    Number.isInteger(stats.delivered) &&
    Number.isInteger(stats.failed) &&
    Number.isInteger(stats.sent) &&
    stats.delivered + stats.failed > stats.sent
  ) {
    errors.push({
      field: "stats",
      message: "stats.delivered + stats.failed must not exceed stats.sent.",
    });
  }
}

function normalizeTemplate(template) {
  return {
    ...template,
    type: template.type,
    body: template.body.trim(),
    variables: Array.isArray(template.variables) ? template.variables : [],
  };
}

function normalizeFilter(filter) {
  return {
    ...filter,
    channels: Array.isArray(filter.channels) ? filter.channels : [],
    tags: Array.isArray(filter.tags) ? filter.tags : [],
    segment_ids: Array.isArray(filter.segment_ids) ? filter.segment_ids : [],
    criteria: isRecord(filter.criteria) ? filter.criteria : {},
  };
}

function normalizeSchedule(schedule) {
  return {
    ...schedule,
  };
}

function normalizeRateLimit(rateLimit) {
  return {
    ...rateLimit,
    strategy: rateLimit.strategy ?? "fixed",
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

function expectIsoDateTime(errors, value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push({
      field,
      message: "Field must be an ISO-8601 date-time string.",
    });
  }
}

function expectOptionalIsoDateTime(errors, value, field) {
  if (value !== undefined) {
    expectIsoDateTime(errors, value, field);
  }
}

function expectPositiveInteger(errors, value, field) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push({
      field,
      message: "Field must be a positive integer.",
    });
  }
}

function expectNonNegativeInteger(errors, value, field) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push({
      field,
      message: "Field must be a non-negative integer.",
    });
  }
}

function validateStringArray(errors, value, path) {
  if (!Array.isArray(value)) {
    errors.push({
      field: path,
      message: "Field must be an array.",
    });
    return;
  }

  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push({
        field: `${path}[${index}]`,
        message: "Array item must be a non-empty string.",
      });
    }
  });
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
