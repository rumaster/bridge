import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readContract() {
  return readJson("packages/contracts/consumer/saas-admin-c3.consumer.v1.json");
}

describe("SVC-ADMIN C3 consumer contract", () => {
  it("publishes the M1 SaaS Admin C3 consumer contract", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "C3.saas-admin.consumer");
    assert.equal(contract["x-consumer"], "SVC-ADMIN");
    assert.equal(contract["x-provider"], "Backend API C3");
    assert.equal(contract["x-stage"], "M1");
  });

  it("freezes the M1 endpoint set used by SaaS Admin", () => {
    const contract = readContract();

    assert.deepEqual(
      contract.interactions.map((interaction) => [interaction.method, interaction.path]),
      [
        ["POST", "/auth/login/telegram/start"],
        ["POST", "/auth/login/telegram/verify"],
        ["GET", "/auth/session"],
        ["POST", "/auth/logout"],
        ["GET", "/organizations/{organizationId}"],
        ["PATCH", "/organizations/{organizationId}"],
        ["GET", "/organizations/{organizationId}/configuration"],
        ["PUT", "/organizations/{organizationId}/configuration"],
      ],
    );
  });

  it("keeps every consumed endpoint published in C3 OpenAPI artifacts", () => {
    const contract = readContract();
    const authOpenApi = readJson("packages/contracts/openapi/auth/c3.auth.openapi.json");
    const backendOpenApi = readJson("packages/contracts/openapi/backend-core/openapi.json");
    const authPaths = new Set(Object.keys(authOpenApi.paths));
    const backendPaths = new Set(
      Object.keys(backendOpenApi.paths).map((path) => path.replace(/^\/api\/v1/, "")),
    );

    for (const interaction of contract.interactions) {
      const paths = interaction.path.startsWith("/auth/") ? authPaths : backendPaths;
      const providerPath =
        interaction.path === "/organizations/{organizationId}"
          ? "/organizations/{id}"
          : interaction.path;
      const methods =
        paths === authPaths
          ? authOpenApi.paths[interaction.path]
          : backendOpenApi.paths[`/api/v1${providerPath}`];

      assert.equal(paths.has(providerPath), true, `${interaction.path} is not published`);
      assert.ok(
        methods?.[interaction.method.toLowerCase()],
        `${interaction.method} ${interaction.path} is not published`,
      );
    }
  });

  it("requires audit metadata for mutating organization operations", () => {
    const contract = readContract();
    const mutating = contract.interactions.filter((interaction) =>
      ["PATCH", "PUT"].includes(interaction.method),
    );

    assert.deepEqual(
      mutating.map((interaction) => [interaction.method, interaction.path, interaction.audit]),
      [
        [
          "PATCH",
          "/organizations/{organizationId}",
          { required: true, action: "organization.update" },
        ],
        [
          "PUT",
          "/organizations/{organizationId}/configuration",
          { required: true, action: "configuration.put" },
        ],
      ],
    );
  });
});
