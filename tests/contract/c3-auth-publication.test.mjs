import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const contractPath = join(
  root,
  "packages",
  "contracts",
  "openapi",
  "auth",
  "c3.auth.openapi.json",
);

function readContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

describe("C3.auth contract publication", () => {
  it("publishes C3.auth under packages/contracts/openapi/auth", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "C3.auth");
    assert.equal(contract["x-owner"], "SVC-IDN");
    assert.equal(contract["x-stage"], "M0");
  });

  it("keeps the public endpoint set frozen for M0", () => {
    const contract = readContract();

    assert.deepEqual(Object.entries(contract.paths).map(([path, methods]) => [
      path,
      Object.keys(methods),
    ]), [
      ["/auth/login/telegram/start", ["post"]],
      ["/auth/login/telegram/verify", ["post"]],
      ["/auth/logout", ["post"]],
      ["/auth/session", ["get"]],
    ]);
  });
});
