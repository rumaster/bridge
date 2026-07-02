import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { C6_CAPABILITIES } from "../../packages/contracts/src/c6.mjs";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("INT <-> CORE M0 contracts", () => {
  it("freezes the C2 ingress and egress endpoint names", () => {
    const openApi = readFileSync(
      join(root, "packages/contracts/openapi/c2-internal-api.yaml"),
      "utf8",
    );

    assert.match(openApi, /\/internal\/ingress\/messages:/);
    assert.match(openApi, /\/internal\/egress\/deliveries:/);
    assert.match(openApi, /c2-ingress-message\.schema\.json/);
    assert.match(openApi, /c2-egress-delivery\.schema\.json/);
  });

  it("keeps C6 v1 capability schema aligned with the runtime constant", () => {
    const schema = readJson(
      "packages/contracts/json-schema/c6-capability-descriptor.schema.json",
    );

    assert.deepEqual(
      schema.properties.capabilities.required,
      C6_CAPABILITIES,
    );
  });
});
