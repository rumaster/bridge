import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

const frontendSkeletons = [
  {
    name: "@bridge/saas-admin",
    packagePath: "apps/saas-admin/package.json",
    apiClientSource: "apps/saas-admin/src/api/client/http.ts",
    mswFiles: [
      "apps/saas-admin/public/mockServiceWorker.js",
      "apps/saas-admin/src/api/mocks/browser.ts",
      "apps/saas-admin/src/api/mocks/node.ts",
      "apps/saas-admin/src/api/mocks/handlers.ts",
    ],
  },
  {
    name: "@bridge/manager-workspace",
    packagePath: "apps/manager-workspace/package.json",
    apiClientSource: "apps/manager-workspace/src/api/client/http.ts",
    mswFiles: [
      "apps/manager-workspace/public/mockServiceWorker.js",
      "apps/manager-workspace/src/api/mocks/browser.ts",
      "apps/manager-workspace/src/api/mocks/node.ts",
      "apps/manager-workspace/src/api/mocks/handlers.ts",
    ],
  },
  {
    name: "@bridge/web-chat",
    packagePath: "apps/web-chat/package.json",
    apiClientSource: "apps/web-chat/src/platform/apiClient.ts",
    mswFiles: [
      "apps/web-chat/public/mockServiceWorker.js",
      "apps/web-chat/src/mocks/browser.ts",
      "apps/web-chat/src/mocks/server.ts",
      "apps/web-chat/src/mocks/handlers.ts",
    ],
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

describe("M0 frontend skeleton gate", () => {
  it("publishes a common api-client package instead of an empty placeholder", () => {
    const manifest = readJson("packages/api-client/package.json");

    assert.equal(manifest.name, "@bridge/api-client");
    assert.equal(manifest.exports["."].default, "./src/index.mjs");
    assert.equal(manifest.exports["."].types, "./src/index.d.ts");
    assert.equal(existsSync(join(root, "packages/api-client/src/index.mjs")), true);
    assert.equal(existsSync(join(root, "packages/api-client/src/index.d.ts")), true);
  });

  it("wires each frontend skeleton to @bridge/api-client and MSW", () => {
    for (const skeleton of frontendSkeletons) {
      const manifest = readJson(skeleton.packagePath);
      const apiClientSource = readText(skeleton.apiClientSource);

      assert.equal(manifest.dependencies?.["@bridge/api-client"], "0.0.0", skeleton.name);
      assert.equal(manifest.devDependencies?.msw.startsWith("^"), true, skeleton.name);
      assert.match(apiClientSource, /from "@bridge\/api-client"/, skeleton.name);
      assert.doesNotMatch(apiClientSource, /TODO.*@bridge\/api-client/i, skeleton.name);

      for (const filePath of skeleton.mswFiles) {
        assert.equal(existsSync(join(root, filePath)), true, `${skeleton.name}: ${filePath}`);
      }
    }
  });
});
