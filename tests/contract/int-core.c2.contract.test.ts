import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

describe("INT <-> CORE C2 contract smoke", () => {
  it("publishes an OpenAPI contract for ingress and egress", () => {
    const contract = JSON.parse(
      readFileSync(
        join(root, "packages/contracts/openapi/communication-core-c2.openapi.json"),
        "utf8",
      ),
    );

    assert.equal(contract.openapi, "3.1.0");
    assert.ok(contract.paths["/internal/ingress/messages"].post);
    assert.ok(contract.paths["/internal/delivery/dispatch"].post);
    assert.equal(contract.paths["/internal/egress/messages"], undefined);
    assert.equal(JSON.stringify(contract).includes("mock_delivery"), false);
  });
});
