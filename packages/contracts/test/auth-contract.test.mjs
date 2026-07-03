import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const contractPath = join(
  process.cwd(),
  "openapi",
  "auth",
  "c3.auth.openapi.json",
);

function readContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

describe("C3.auth OpenAPI contract", () => {
  it("publishes the frozen v1 M1 auth contract metadata", () => {
    const contract = readContract();

    assert.equal(contract.openapi, "3.1.0");
    assert.equal(contract.info.title, "Bridge C3.auth API");
    assert.equal(contract.info.version, "1.0.0");
    assert.equal(contract["x-contract-id"], "C3.auth");
    assert.deepEqual(contract.servers, [{ url: "/api/v1" }]);
  });

  it("defines all M1 auth endpoints", () => {
    const contract = readContract();

    assert.deepEqual(Object.keys(contract.paths).sort(), [
      "/auth/login/telegram/start",
      "/auth/login/telegram/verify",
      "/auth/logout",
      "/auth/session",
    ]);

    assert.ok(contract.paths["/auth/login/telegram/start"].post);
    assert.ok(contract.paths["/auth/login/telegram/verify"].post);
    assert.ok(contract.paths["/auth/logout"].post);
    assert.ok(contract.paths["/auth/session"].get);
  });

  it("references DTO schemas for request and response payloads", () => {
    const contract = readContract();
    const schemas = contract.components.schemas;

    for (const schemaName of [
      "TelegramLoginStartRequest",
      "TelegramLoginStartResponse",
      "TelegramLoginVerifyRequest",
      "AuthSessionResponse",
      "LogoutResponse",
      "ProblemDetails",
    ]) {
      assert.ok(schemas[schemaName], schemaName);
    }

    assert.deepEqual(
      schemas.TelegramLoginStartRequest.required,
      ["telegramUsername"],
    );
    assert.deepEqual(schemas.TelegramLoginVerifyRequest.required, ["code"]);
    assert.ok(schemas.TelegramLoginVerifyRequest.properties.requestId);
    assert.ok(schemas.TelegramLoginStartResponse.properties.requestId);
    assert.equal(
      schemas.AuthSessionResponse.required.includes("token"),
      true,
    );
    assert.equal(
      contract.paths["/auth/login/telegram/verify"].post.description.includes(
        "code_hash",
      ),
      true,
    );
    assert.deepEqual(
      Object.keys(contract.paths["/auth/login/telegram/start"].post.responses),
      ["202", "400", "401", "429"],
    );
  });
});
