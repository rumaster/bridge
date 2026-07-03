import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../packages/contracts/src/c4.mjs";
import { createDeterministicMockLlm } from "../../services/ai-platform/src/llm.mjs";
import { createOnboardingCommander } from "../../services/ai-platform/src/onboarding.mjs";

const fixedNow = () => "2026-07-03T10:00:00.000Z";
const ORG_A = "org-integration-a";
const ORG_B = "org-integration-b";

/**
 * Backend↔AI Platform integration (ТЗ §26.4, CP-5) at the contract level, driven
 * by the deterministic mock LLM. SVC-AI interprets the administrator request into
 * a §12.6 command; a Backend stand-in re-validates the schema, checks tenant and
 * rights, and only then applies the change to its in-memory configuration store —
 * the single sanctioned write path (ТЗ §12.6, §13.13). The DB-backed apply with
 * audit is proven against Postgres in
 * `services/backend/test/integration/m3-facades.spec.ts`.
 */
function createBackendStandIn() {
  const store = new Map();

  return {
    getConfiguration(organizationId, key) {
      return store.get(`${organizationId}:${key}`);
    },

    /**
     * The sanctioned apply path, mirroring WorkflowActionApplierService: schema
     * validation → tenant check → rights check → domain mutation.
     */
    apply({ command, organizationId, roles }) {
      const validation = validateAiOnboardingCommand(command);
      if (!validation.valid) {
        return { status: "rejected", reason: "COMMAND_INVALID", errors: validation.errors };
      }

      if (command.organization_id !== organizationId) {
        return { status: "rejected", reason: "COMMAND_ORG_MISMATCH" };
      }

      const requiresAdministrator = command.action !== "noop";
      if (requiresAdministrator && !roles.includes("administrator")) {
        return { status: "rejected", reason: "ROLE_FORBIDDEN" };
      }

      if (command.action === "configuration.upsert") {
        const { key, value } = command.params;
        store.set(`${organizationId}:${key}`, value);
        return { status: "applied", action: command.action, key, value };
      }

      return { status: "noop", action: command.action };
    },
  };
}

describe("Backend↔AI onboarding integration (mock LLM, CP-5)", () => {
  it("interprets a NL request and applies the resulting §12.6 command via Backend", async () => {
    const commander = createOnboardingCommander({
      llm: createDeterministicMockLlm(),
      now: fixedNow,
    });
    const backend = createBackendStandIn();

    const response = await commander.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-apply-a",
      organization_id: ORG_A,
      actor_user_id: "admin-a",
      prompt: "Установи часовой пояс Europe/Moscow",
    });

    const result = backend.apply({
      command: response.command,
      organizationId: ORG_A,
      roles: ["administrator"],
    });

    assert.equal(result.status, "applied");
    assert.equal(result.key, "organization.timezone");
    assert.equal(backend.getConfiguration(ORG_A, "organization.timezone"), "Europe/Moscow");
  });

  it("keeps tenant isolation — a command for org A is refused in org B's context", async () => {
    const commander = createOnboardingCommander({ now: fixedNow });
    const backend = createBackendStandIn();

    const response = await commander.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-apply-cross",
      organization_id: ORG_A,
      actor_user_id: "admin-a",
      prompt: "Установи часовой пояс Europe/Moscow",
    });

    const crossTenant = backend.apply({
      command: response.command,
      organizationId: ORG_B,
      roles: ["administrator"],
    });

    assert.equal(crossTenant.status, "rejected");
    assert.equal(crossTenant.reason, "COMMAND_ORG_MISMATCH");
    assert.equal(backend.getConfiguration(ORG_B, "organization.timezone"), undefined);
  });

  it("refuses to apply a sanctioned change without the administrator role", async () => {
    const commander = createOnboardingCommander({ now: fixedNow });
    const backend = createBackendStandIn();

    const response = await commander.createOnboardingCommand({
      contract: "C4.OnboardingCommandRequest",
      version: "1.0.0",
      request_id: "req-apply-rights",
      organization_id: ORG_A,
      actor_user_id: "manager-a",
      prompt: "Установи часовой пояс Europe/Moscow",
    });

    const result = backend.apply({
      command: response.command,
      organizationId: ORG_A,
      roles: ["manager"],
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "ROLE_FORBIDDEN");
    assert.equal(backend.getConfiguration(ORG_A, "organization.timezone"), undefined);
  });
});
