export const C6_CONTRACT = "C6.CapabilityDescriptor";
export const C6_VERSION = "1.0.0";

export const C6_CAPABILITIES = Object.freeze([
  "text",
  "image",
  "file",
  "voice",
  "video",
  "buttons",
  "reactions",
  "typing_indicator",
  "read_receipt",
  "delete",
  "edit",
]);

const C6_CAPABILITY_SET = new Set(C6_CAPABILITIES);

export function createCapabilityDescriptor({
  channelType,
  channelId,
  adapterName,
  adapterVersion = "0.0.0",
  capabilities,
  generatedAt = new Date().toISOString(),
}) {
  const descriptor = {
    contract: C6_CONTRACT,
    version: C6_VERSION,
    channel_type: channelType,
    adapter: {
      name: adapterName,
      version: adapterVersion,
    },
    capabilities,
    generated_at: generatedAt,
  };

  if (channelId !== undefined) {
    descriptor.channel_id = channelId;
  }

  return descriptor;
}

export function validateCapabilityDescriptor(descriptor) {
  const errors = [];

  if (!isRecord(descriptor)) {
    return { valid: false, errors: ["descriptor must be an object"] };
  }

  expectEqual(errors, descriptor.contract, C6_CONTRACT, "contract");
  expectEqual(errors, descriptor.version, C6_VERSION, "version");
  expectNonEmptyString(errors, descriptor.channel_type, "channel_type");

  if (descriptor.channel_id !== undefined) {
    expectNonEmptyString(errors, descriptor.channel_id, "channel_id");
  }

  if (!isRecord(descriptor.adapter)) {
    errors.push("adapter must be an object");
  } else {
    expectNonEmptyString(errors, descriptor.adapter.name, "adapter.name");
    expectNonEmptyString(errors, descriptor.adapter.version, "adapter.version");
  }

  validateCapabilities(errors, descriptor.capabilities);
  expectIsoDateTime(errors, descriptor.generated_at, "generated_at");

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateCapabilities(errors, capabilities) {
  if (!isRecord(capabilities)) {
    errors.push("capabilities must be an object");
    return;
  }

  for (const capability of C6_CAPABILITIES) {
    if (!Object.hasOwn(capabilities, capability)) {
      errors.push(`capabilities.${capability} is required`);
    }
  }

  for (const [capability, value] of Object.entries(capabilities)) {
    if (!C6_CAPABILITY_SET.has(capability)) {
      errors.push(`capabilities.${capability} is not part of C6 v1`);
      continue;
    }

    if (!isRecord(value)) {
      errors.push(`capabilities.${capability} must be an object`);
      continue;
    }

    if (typeof value.supported !== "boolean") {
      errors.push(`capabilities.${capability}.supported must be a boolean`);
    }

    if (value.constraints !== undefined && !isRecord(value.constraints)) {
      errors.push(`capabilities.${capability}.constraints must be an object`);
    }

    if (value.notes !== undefined && typeof value.notes !== "string") {
      errors.push(`capabilities.${capability}.notes must be a string`);
    }
  }
}

function expectEqual(errors, actual, expected, path) {
  if (actual !== expected) {
    errors.push(`${path} must equal ${JSON.stringify(expected)}`);
  }
}

function expectNonEmptyString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}

function expectIsoDateTime(errors, value, path) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be an ISO-8601 date-time string`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
