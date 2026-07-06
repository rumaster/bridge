/**
 * Minimal JSON Schema validator ported to TypeScript from the canonical ESM
 * implementation in `packages/contracts/src/c4.ts` (`validateJsonSchema`). The
 * backend is compiled to CommonJS and cannot statically import the ESM-only
 * `@bridge/contracts` package at runtime, so the validator lives here and a
 * drift-detection test (`json-schema-validator.spec.ts`) asserts the ported
 * behaviour keeps matching the contract source.
 *
 * Supported keywords (the subset the C4 §12.6 command schema uses): const, enum,
 * type, minLength, maxLength, pattern, format:date-time, minimum, maximum,
 * minItems, maxItems, items, required, properties, additionalProperties:false.
 */

export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): JsonSchemaValidationResult {
  const errors: string[] = [];
  visitJsonSchema(value, schema, "$", errors);

  return { valid: errors.length === 0, errors };
}

function visitJsonSchema(
  value: unknown,
  schema: unknown,
  path: string,
  errors: string[],
): void {
  if (schema === null || typeof schema !== "object") {
    return;
  }

  const node = schema as JsonSchema;

  if (Object.hasOwn(node, "const") && value !== node.const) {
    errors.push(`${path} must equal ${JSON.stringify(node.const)}`);
  }

  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    errors.push(
      `${path} must be one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }

  if (node.type && !matchesJsonType(value, node.type as string | string[])) {
    errors.push(
      `${path} must be ${Array.isArray(node.type) ? (node.type as string[]).join(" or ") : node.type}`,
    );
    return;
  }

  if (typeof value === "string") {
    validateStringKeywords(value, node, path, errors);
  }

  if (typeof value === "number") {
    validateNumberKeywords(value, node, path, errors);
  }

  if (Array.isArray(value)) {
    validateArrayKeywords(value, node, path, errors);
  }

  if (isRecord(value)) {
    validateObjectKeywords(value, node, path, errors);
  }
}

function matchesJsonType(value: unknown, expected: string | string[]): boolean {
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

function validateStringKeywords(
  value: string,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
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

function validateNumberKeywords(
  value: number,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }

  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }
}

function validateArrayKeywords(
  value: unknown[],
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
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

function validateObjectKeywords(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
