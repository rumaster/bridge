import { C5_VERSION } from "../../../packages/contracts/src/c5.mjs";

const START_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "workflow_version_id",
  "input",
  "context",
]);

const CALLBACK_FIELDS = new Set([
  "contract",
  "version",
  "request_id",
  "organization_id",
  "workflow_id",
  "workflow_version_id",
  "instance_id",
  "node_id",
  "context",
  "backend_request",
]);

const CONTEXT_FIELDS = new Set([
  "organization_id",
  "actor_user_id",
  "trigger",
  "roles",
  "correlation_id",
  "locale",
]);

const BACKEND_REQUEST_FIELDS = new Set([
  "method",
  "path",
  "headers",
  "query",
  "body",
  "timeout_ms",
]);

const TRIGGERS = new Set(["manual", "message", "system", "workflow"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export class C5DtoValidationError extends Error {
  constructor(errors) {
    super(`C5 DTO validation failed: ${errors.map((error) => error.field).join(", ")}`);
    this.name = "C5DtoValidationError";
    this.errors = errors;
  }
}

export function validateStartWorkflowInstanceRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, START_FIELDS);
  expectConst(errors, input.contract, "C5.StartWorkflowInstanceRequest", "contract");
  expectConst(errors, input.version, C5_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.workflow_version_id, "workflow_version_id");

  if (Object.hasOwn(input, "input") && !isRecord(input.input)) {
    errors.push({
      field: "input",
      message: "input must be an object when provided.",
    });
  }

  validateExecutionContext(errors, input.context, "context", input.organization_id);

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
      input: input.input ?? {},
      context: normalizeExecutionContext(input.context),
    },
  };
}

export function validateBackendApiCallbackRequest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return invalidPayload();
  }

  rejectUnknownFields(errors, input, CALLBACK_FIELDS);
  expectConst(errors, input.contract, "C5.BackendApiNodeCallbackRequest", "contract");
  expectConst(errors, input.version, C5_VERSION, "version");
  expectNonEmptyString(errors, input.request_id, "request_id");
  expectNonEmptyString(errors, input.organization_id, "organization_id");
  expectNonEmptyString(errors, input.workflow_id, "workflow_id");
  expectNonEmptyString(errors, input.workflow_version_id, "workflow_version_id");
  expectNonEmptyString(errors, input.instance_id, "instance_id");
  expectNonEmptyString(errors, input.node_id, "node_id");
  validateExecutionContext(errors, input.context, "context", input.organization_id);
  validateBackendRequest(errors, input.backend_request);

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
      context: normalizeExecutionContext(input.context),
      backend_request: normalizeBackendRequest(input.backend_request),
    },
  };
}

export function assertStartWorkflowInstanceRequest(input) {
  const result = validateStartWorkflowInstanceRequest(input);
  if (!result.ok) {
    throw new C5DtoValidationError(result.errors);
  }
  return result.value;
}

export function assertBackendApiCallbackRequest(input) {
  const result = validateBackendApiCallbackRequest(input);
  if (!result.ok) {
    throw new C5DtoValidationError(result.errors);
  }
  return result.value;
}

function validateExecutionContext(errors, context, path, organizationId) {
  if (!isRecord(context)) {
    errors.push({
      field: path,
      message: "context must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, context, CONTEXT_FIELDS, path);
  expectNonEmptyString(errors, context.organization_id, `${path}.organization_id`);
  expectNonEmptyString(errors, context.actor_user_id, `${path}.actor_user_id`);
  expectNonEmptyString(errors, context.trigger, `${path}.trigger`);

  if (typeof context.trigger === "string" && !TRIGGERS.has(context.trigger)) {
    errors.push({
      field: `${path}.trigger`,
      message: "trigger must be one of manual, message, system or workflow.",
    });
  }

  if (
    typeof organizationId === "string" &&
    organizationId.trim() !== "" &&
    typeof context.organization_id === "string" &&
    context.organization_id !== organizationId
  ) {
    errors.push({
      field: `${path}.organization_id`,
      message: "context.organization_id must match organization_id.",
    });
  }

  if (Object.hasOwn(context, "roles")) {
    validateStringArray(errors, context.roles, `${path}.roles`);
  }

  expectOptionalNonEmptyString(errors, context.correlation_id, `${path}.correlation_id`);
  expectOptionalNonEmptyString(errors, context.locale, `${path}.locale`);
}

function validateBackendRequest(errors, backendRequest) {
  if (!isRecord(backendRequest)) {
    errors.push({
      field: "backend_request",
      message: "backend_request must be an object.",
    });
    return;
  }

  rejectUnknownFields(errors, backendRequest, BACKEND_REQUEST_FIELDS, "backend_request");
  expectNonEmptyString(errors, backendRequest.method, "backend_request.method");
  expectNonEmptyString(errors, backendRequest.path, "backend_request.path");

  if (
    typeof backendRequest.method === "string" &&
    !HTTP_METHODS.has(backendRequest.method.toUpperCase())
  ) {
    errors.push({
      field: "backend_request.method",
      message: "method must be one of GET, POST, PUT, PATCH or DELETE.",
    });
  }

  if (
    typeof backendRequest.path === "string" &&
    backendRequest.path !== "/api/v1" &&
    !backendRequest.path.startsWith("/api/v1/")
  ) {
    errors.push({
      field: "backend_request.path",
      message: "path must target the public Backend API under /api/v1.",
    });
  }

  if (Object.hasOwn(backendRequest, "headers")) {
    validateStringRecord(errors, backendRequest.headers, "backend_request.headers");
  }

  if (Object.hasOwn(backendRequest, "query") && !isRecord(backendRequest.query)) {
    errors.push({
      field: "backend_request.query",
      message: "query must be an object when provided.",
    });
  }

  if (
    Object.hasOwn(backendRequest, "timeout_ms") &&
    (!Number.isInteger(backendRequest.timeout_ms) ||
      backendRequest.timeout_ms < 1 ||
      backendRequest.timeout_ms > 30000)
  ) {
    errors.push({
      field: "backend_request.timeout_ms",
      message: "timeout_ms must be an integer between 1 and 30000.",
    });
  }
}

function normalizeExecutionContext(context) {
  return {
    ...context,
    roles: Array.isArray(context.roles) ? context.roles : [],
  };
}

function normalizeBackendRequest(backendRequest) {
  return {
    ...backendRequest,
    method: backendRequest.method.toUpperCase(),
    headers: backendRequest.headers ?? {},
    query: backendRequest.query ?? {},
    body: Object.hasOwn(backendRequest, "body") ? backendRequest.body : null,
    timeout_ms: backendRequest.timeout_ms ?? 250,
  };
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

function validateStringRecord(errors, value, path) {
  if (!isRecord(value)) {
    errors.push({
      field: path,
      message: "Field must be an object.",
    });
    return;
  }

  for (const [field, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== "string") {
      errors.push({
        field: `${path}.${field}`,
        message: "Header value must be a string.",
      });
    }
  }
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
