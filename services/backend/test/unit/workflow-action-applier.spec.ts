import { BadRequestException, ForbiddenException } from "@nestjs/common";

import type { RoleCode } from "../../src/common/auth/auth-context";
import { WorkflowActionApplierService } from "../../src/modules/backend-api/workflow-action-applier.service";
import type {
  ApplyActionInput,
  ApplyActorType,
} from "../../src/modules/backend-api/workflow-action-applier.service";
import type { AiOnboardingCommandAction } from "../../src/modules/ai-integration/ai-onboarding-command.schema";

const ORG = "00000000-0000-4000-8000-000000000101";
const ACTOR = "00000000-0000-4000-8000-000000000201";

interface Mocks {
  database: { withTenant: jest.Mock };
  audit: { record: jest.Mock };
  configuration: { putConfiguration: jest.Mock };
  organization: { updateOrganization: jest.Mock };
}

function buildCommand(
  action: AiOnboardingCommandAction,
  params: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract: "C4.AiOnboardingCommand",
    version: "1.0.0",
    command_id: "cmd-1",
    organization_id: ORG,
    action,
    params,
    safety: {
      apply_mode: "backend_validation_required",
      requires_confirmation: false,
      notes: [],
    },
    source: { prompt: "настрой", generated_by: "deterministic-mock-ai" },
    created_at: "2026-07-03T10:00:00.000Z",
    ...overrides,
  };
}

function createService(): { service: WorkflowActionApplierService; mocks: Mocks } {
  const mocks: Mocks = {
    database: {
      withTenant: jest.fn((_org: string, cb: (client: unknown) => unknown) => cb({})),
    },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    configuration: {
      putConfiguration: jest.fn().mockResolvedValue({ key: "organization.timezone", version: 3 }),
    },
    organization: {
      updateOrganization: jest.fn().mockResolvedValue({ status: "active" }),
    },
  };

  const service = new WorkflowActionApplierService(
    mocks.database as never,
    mocks.audit as never,
    mocks.configuration as never,
    mocks.organization as never,
  );

  return { service, mocks };
}

function input(
  command: Record<string, unknown>,
  roles: RoleCode[],
  actorType: ApplyActorType = "ai",
): ApplyActionInput {
  return {
    command,
    organizationId: ORG,
    actorType,
    actorUserId: ACTOR,
    roles,
    requestId: "req-1",
  };
}

describe("WorkflowActionApplierService", () => {
  it("applies configuration.upsert for an administrator and audits with actor_type", async () => {
    const { service, mocks } = createService();
    const command = buildCommand("configuration.upsert", {
      key: "organization.timezone",
      value: { timezone: "Europe/Moscow" },
    });

    const result = await service.apply(input(command, ["administrator"], "ai"));

    expect(result).toEqual({
      action: "configuration.upsert",
      applied: true,
      status: "applied",
      detail: { key: "organization.timezone", version: 3 },
    });
    expect(mocks.configuration.putConfiguration).toHaveBeenCalledWith(
      ORG,
      { key: "organization.timezone", value: { timezone: "Europe/Moscow" } },
      { actorType: "ai", actorUserId: ACTOR, requestId: "req-1" },
    );
    expect(mocks.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "ai_onboarding.apply",
        actorType: "ai",
        result: "success",
        objectType: "ai_onboarding_command",
      }),
    );
  });

  it("maps display_name to name for organization.update_profile and audits workflow actor", async () => {
    const { service, mocks } = createService();
    const command = buildCommand("organization.update_profile", { display_name: "Bridge Inc." });

    const result = await service.apply(input(command, ["administrator"], "workflow"));

    expect(result.status).toBe("applied");
    expect(mocks.organization.updateOrganization).toHaveBeenCalledWith(
      ORG,
      { name: "Bridge Inc." },
      { actorType: "workflow", actorUserId: ACTOR, requestId: "req-1" },
    );
    expect(mocks.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow.backend_api_node",
        actorType: "workflow",
        objectType: "workflow_backend_api_node",
        result: "success",
      }),
    );
  });

  it("denies a mutating action without the administrator role and audits the denial", async () => {
    const { service, mocks } = createService();
    const command = buildCommand("configuration.upsert", { value: { ai: { enabled: true } } });

    await expect(service.apply(input(command, ["manager"]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mocks.configuration.putConfiguration).not.toHaveBeenCalled();
    expect(mocks.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "denied", actorType: "ai" }),
    );
  });

  it("allows noop for a non-administrator without touching any domain service", async () => {
    const { service, mocks } = createService();
    const command = buildCommand("noop", {});

    const result = await service.apply(input(command, ["manager"]));

    expect(result).toEqual({ action: "noop", applied: false, status: "noop", detail: {} });
    expect(mocks.configuration.putConfiguration).not.toHaveBeenCalled();
    expect(mocks.organization.updateOrganization).not.toHaveBeenCalled();
    expect(mocks.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "success" }),
    );
  });

  it("acknowledges not-yet-supported actions without mutating data", async () => {
    const { service } = createService();
    const command = buildCommand("channel.connect", { provider: "telegram" });

    const result = await service.apply(input(command, ["administrator"]));

    expect(result).toEqual({
      action: "channel.connect",
      applied: false,
      status: "not_supported",
      detail: { reason: "action_not_supported_in_m3" },
    });
  });

  it("rejects a command that fails the §12.6 schema", async () => {
    const { service, mocks } = createService();
    const command = buildCommand("configuration.upsert", { value: {} }, { contract: "wrong" });

    await expect(service.apply(input(command, ["administrator"]))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });

  it("rejects a command whose organization does not match the tenant", async () => {
    const { service } = createService();
    const command = buildCommand(
      "configuration.upsert",
      { value: {} },
      { organization_id: "00000000-0000-4000-8000-000000000999" },
    );

    await expect(service.apply(input(command, ["administrator"]))).rejects.toMatchObject({
      response: expect.objectContaining({ code: "COMMAND_ORG_MISMATCH" }),
    });
  });
});
