import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const contractPath = join(
  process.cwd(),
  "openapi",
  "auth",
  "c3.auth.openapi.json",
);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

const requiredPaths = new Map([
  ["/auth/login/telegram/start", "post"],
  ["/auth/login/telegram/verify", "post"],
  ["/auth/logout", "post"],
  ["/auth/session", "get"],
]);

assert.equal(contract.openapi, "3.1.0");
assert.equal(contract.info?.version, "1.0.0");
assert.equal(contract["x-contract-id"], "C3.auth");
assert.deepEqual(contract.servers, [{ url: "/api/v1" }]);

for (const [path, method] of requiredPaths) {
  assert.ok(contract.paths?.[path]?.[method], `${method.toUpperCase()} ${path}`);
}

for (const schemaName of [
  "TelegramLoginStartRequest",
  "TelegramLoginStartResponse",
  "TelegramLoginVerifyRequest",
  "AuthSessionResponse",
  "LogoutResponse",
  "ProblemDetails",
]) {
  assert.ok(contract.components?.schemas?.[schemaName], schemaName);
}

console.log("C3.auth OpenAPI contract is published and smoke-verified.");
