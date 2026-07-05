import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C6_CAPABILITIES,
  createCapabilityDescriptor,
  validateCapabilityDescriptor,
} from "../../src/c6.js";

describe("C6 Capability Descriptor validator", () => {
  it("accepts the frozen M0 capability set", () => {
    const descriptor = createCapabilityDescriptor({
      channelType: "mock",
      adapterName: "mock-adapter",
      capabilities: Object.fromEntries(
        C6_CAPABILITIES.map((capability) => [
          capability,
          { supported: true },
        ]),
      ),
    });

    const result = validateCapabilityDescriptor(descriptor);

    assert.equal(result.valid, true);
    assert.deepEqual(
      Object.keys(descriptor.capabilities).sort(),
      [...C6_CAPABILITIES].sort(),
    );
  });

  it("rejects missing required capabilities", () => {
    const descriptor = createCapabilityDescriptor({
      channelType: "mock",
      adapterName: "mock-adapter",
      capabilities: Object.fromEntries(
        C6_CAPABILITIES.filter((capability) => capability !== "read_receipt").map(
          (capability) => [capability, { supported: true }],
        ),
      ),
    });

    const result = validateCapabilityDescriptor(descriptor);

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /capabilities\.read_receipt/);
  });

  it("rejects unknown capabilities", () => {
    const descriptor = createCapabilityDescriptor({
      channelType: "mock",
      adapterName: "mock-adapter",
      capabilities: {
        ...Object.fromEntries(
          C6_CAPABILITIES.map((capability) => [
            capability,
            { supported: true },
          ]),
        ),
        sticker: { supported: true },
      },
    });

    const result = validateCapabilityDescriptor(descriptor);

    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /capabilities\.sticker/);
  });
});
