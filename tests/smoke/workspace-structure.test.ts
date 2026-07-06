import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

const expectedWorkspaceGlobs = [
  "apps/*",
  "services/*",
  "clients/*",
  "packages/*",
];

const expectedWorkspacePackages = [
  "apps/saas-admin",
  "apps/manager-workspace",
  "apps/web-chat",
  "services/backend",
  "services/integration-platform",
  "services/ai-platform",
  "services/fbp-engine",
  "services/broadcast-platform",
  "services/notification-platform",
  "services/edge-gateway",
  "services/mobile-api",
  "clients/telegram-console",
  "packages/contracts",
  "packages/ui-kit",
  "packages/api-client",
  "packages/testing",
];

const expectedDirectories = [
  "apps/saas-admin/src",
  "apps/saas-admin/test",
  "apps/manager-workspace/src",
  "apps/manager-workspace/test",
  "apps/web-chat/src",
  "apps/web-chat/test",
  "services/backend/src/modules/identity",
  "services/backend/src/modules/communication-core",
  "services/backend/src/modules/organization",
  "services/backend/src/modules/user",
  "services/backend/src/modules/client",
  "services/backend/src/modules/conversation",
  "services/backend/src/modules/message",
  "services/backend/src/modules/knowledge-base",
  "services/backend/src/modules/configuration",
  "services/backend/src/modules/audit",
  "services/backend/src/modules/ai-integration",
  "services/backend/src/modules/fbp-integration",
  "services/backend/src/modules/integration-gateway",
  "services/backend/src/modules/broadcast-facade",
  "services/backend/src/modules/notification-facade",
  "services/backend/src/common",
  "services/backend/test/unit",
  "services/backend/test/integration",
  "services/integration-platform/src/adapters/telegram",
  "services/integration-platform/src/adapters/max",
  "services/integration-platform/src/adapters/vk",
  "services/integration-platform/src/adapters/whatsapp",
  "services/integration-platform/src/adapters/web-chat",
  "services/integration-platform/src/adapters/email",
  "services/integration-platform/src/adapters/sms",
  "services/integration-platform/src/capability",
  "services/integration-platform/test/unit",
  "services/integration-platform/test/integration",
  "services/ai-platform/src",
  "services/ai-platform/test/unit",
  "services/ai-platform/test/integration",
  "services/fbp-engine/src",
  "services/fbp-engine/test/unit",
  "services/fbp-engine/test/integration",
  "services/broadcast-platform/src",
  "services/broadcast-platform/test/unit",
  "services/broadcast-platform/test/integration",
  "services/notification-platform/src",
  "services/notification-platform/test/unit",
  "services/notification-platform/test/integration",
  "services/edge-gateway/src",
  "services/edge-gateway/test/unit",
  "services/edge-gateway/test/integration",
  "services/mobile-api/src",
  "services/mobile-api/test/unit",
  "services/mobile-api/test/integration",
  "clients/telegram-console/src",
  "clients/telegram-console/test/unit",
  "packages/contracts/openapi",
  "packages/contracts/message-model",
  "packages/contracts/events",
  "packages/contracts/json-schema",
  "packages/ui-kit/src",
  "packages/ui-kit/test",
  "packages/api-client/src",
  "packages/api-client/test",
  "packages/testing/src",
  "db/migrations",
  "db/seeds",
  "tests/contract",
  "tests/e2e",
  "deploy/docker",
  "deploy/compose",
  "deploy/k8s",
  ".github/workflows",
];

const workspaceScripts = ["lint", "test", "build"];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("M0 workspace skeleton", () => {
  it("declares root workspace commands and workspace globs", () => {
    const rootPackage = readJson("package.json");

    assert.equal(rootPackage.private, true);
    assert.deepEqual(rootPackage.workspaces, expectedWorkspaceGlobs);

    for (const scriptName of workspaceScripts) {
      assert.equal(typeof rootPackage.scripts?.[scriptName], "string");
      assert.notEqual(rootPackage.scripts[scriptName].trim(), "");
    }
  });

  it("contains package manifests for every planned workspace", () => {
    for (const workspace of expectedWorkspacePackages) {
      const manifest = readJson(`${workspace}/package.json`);

      assert.equal(manifest.private, true, workspace);
      for (const scriptName of workspaceScripts) {
        assert.equal(typeof manifest.scripts?.[scriptName], "string", workspace);
      }
    }
  });

  it("contains the baseline directories from the master plan", () => {
    for (const directory of expectedDirectories) {
      assert.equal(existsSync(join(root, directory)), true, directory);
    }
  });
});
