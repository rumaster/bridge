import { describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";
import type { WorkflowSchema } from "../src/api/client/types";

const editedSchema: WorkflowSchema = {
  nodes: [
    {
      id: "node-wait-event-1",
      type: "wait-event",
      label: "Входящее сообщение",
      config: { event_type: "channel.message_received" },
      position: { x: 40, y: 40 }
    },
    {
      id: "node-backend-api-1",
      type: "backend-api",
      label: "Создать тикет",
      config: { path: "/api/v1/tickets" },
      position: { x: 260, y: 40 }
    }
  ],
  connections: [{ id: "conn-1", from: "node-wait-event-1", fromPort: "out", to: "node-backend-api-1", toPort: "in" }]
};

describe("SaaS Administration MSW mocks — M3 Workflow (C5)", () => {
  it("отдаёт список Workflow, версии и сохраняет схему новой неизменяемой версией", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const workflows = await api.workflows.listWorkflows();
    expect(workflows.map((workflow) => workflow.name)).toContain("Автоответчик обращений");

    const versions = await api.workflows.listVersions("wf-support-autoresponder");
    expect(versions).toHaveLength(2);

    const created = await api.workflows.createVersion("wf-support-autoresponder", {
      schema: editedSchema,
      activate: false
    });
    expect(created).toMatchObject({
      id: "wfv-created-1",
      workflow_id: "wf-support-autoresponder",
      version_no: 3
    });

    // Сохранение новой версии без активации не меняет активную версию по умолчанию (ТЗ §13.10).
    const afterCreate = await api.workflows.listWorkflows();
    expect(afterCreate.find((workflow) => workflow.id === "wf-support-autoresponder")).toMatchObject(
      { default_version_id: "wfv-support-2" }
    );

    const versionsAfter = await api.workflows.listVersions("wf-support-autoresponder");
    expect(versionsAfter).toHaveLength(3);
  });

  it("отклоняет схему с запрещёнными узлами и переключает активную версию", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    await expect(
      api.workflows.createVersion("wf-support-autoresponder", {
        schema: { nodes: [], connections: [] },
        activate: false
      })
    ).rejects.toThrow("Request payload does not match C5 workflow version DTO.");

    const activated = await api.workflows.updateWorkflow("wf-support-autoresponder", {
      default_version_id: "wfv-support-1"
    });
    expect(activated.default_version_id).toBe("wfv-support-1");

    const disabled = await api.workflows.updateWorkflow("wf-support-autoresponder", {
      enabled: false
    });
    expect(disabled.enabled).toBe(false);

    // Несуществующая версия отклоняется Backend.
    await expect(
      api.workflows.updateWorkflow("wf-support-autoresponder", {
        default_version_id: "wfv-ghost"
      })
    ).rejects.toThrow();
  });

  it("сохраняет, читает, публикует и сбрасывает persisted draft Workflow", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const emptyDraft = await api.workflows.getDraft("wf-support-autoresponder");
    expect(emptyDraft).toMatchObject({
      has_draft: false,
      schema: null,
      workflow_id: "wf-support-autoresponder"
    });

    const saved = await api.workflows.saveDraft("wf-support-autoresponder", {
      schema: editedSchema
    });
    expect(saved).toMatchObject({
      has_draft: true,
      schema: editedSchema,
      workflow_id: "wf-support-autoresponder"
    });

    const reloaded = await api.workflows.getDraft("wf-support-autoresponder");
    expect(reloaded.schema).toEqual(editedSchema);

    const promoted = await api.workflows.promoteDraft("wf-support-autoresponder");
    expect(promoted).toMatchObject({
      id: "wfv-created-1",
      schema: editedSchema,
      version_no: 3,
      workflow_id: "wf-support-autoresponder"
    });
    const afterPromote = await api.workflows.getDraft("wf-support-autoresponder");
    expect(afterPromote).toMatchObject({ has_draft: false, schema: null });

    await api.workflows.saveDraft("wf-support-autoresponder", { schema: editedSchema });
    const reset = await api.workflows.resetDraft("wf-support-autoresponder");
    expect(reset).toMatchObject({ has_draft: false, schema: null });
  });

  it("отдаёт историю исполнения и диагностику инстанса", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const instances = await api.workflows.listInstances("wf-support-autoresponder");
    expect(instances.map((instance) => instance.id)).toContain("wfi-support-1001");

    const detail = await api.workflows.getInstance("wf-support-autoresponder", "wfi-support-1001");
    expect(detail.status).toBe("completed");
    expect(detail.logs).toHaveLength(5);
    expect(detail.logs.at(-1)?.event).toBe("instance.completed");
  });
});

describe("SaaS Administration MSW mocks — M3 AI Onboarding (C4)", () => {
  it("формирует детерминированную команду и применяет её через Backend", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const command = await api.onboarding.createCommand({
      prompt: "Подними месячный лимит сообщений до 50000"
    });
    expect(command).toMatchObject({
      contract: "C4.OnboardingCommandResponse",
      degraded: false,
      command: {
        action: "configuration.upsert",
        safety: { apply_mode: "backend_validation_required", requires_confirmation: true },
        source: { generated_by: "generated" }
      }
    });
    expect(command.command.params).toMatchObject({
      value: { monthlyMessageLimit: 50000 }
    });

    const applied = await api.onboarding.applyCommand({ command: command.command });
    expect(applied).toMatchObject({
      contract: "C4.OnboardingApplyResponse",
      result: { action: "configuration.upsert", applied: true, status: "applied" },
      configuration: { monthlyMessageLimit: 50000 }
    });

    // UI/Backend отражают изменение конфигурации на организации.
    const configuration = await api.org.getConfiguration(applied.organization_id);
    expect(configuration.monthlyMessageLimit).toBe(50000);
  });

  it("возвращает not_supported для действий вне объёма M3", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const command = await api.onboarding.createCommand({
      prompt: "Пригласи нового пользователя в организацию"
    });
    expect(command.command.action).toBe("user.invite");

    const applied = await api.onboarding.applyCommand({ command: command.command });
    expect(applied.result).toMatchObject({
      applied: false,
      status: "not_supported"
    });
  });

  it("отклоняет пустой запрос онбординга", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    await expect(api.onboarding.createCommand({ prompt: "   " })).rejects.toThrow(
      "Request payload does not match C4 onboarding DTO."
    );
  });
});
