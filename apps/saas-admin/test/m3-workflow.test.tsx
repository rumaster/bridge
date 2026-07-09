import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import type { WorkflowSchema } from "../src/api/client/types";
import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { createMockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

function createWorkflowOperatorApi() {
  return createMockSaasAdminApiClient({
    session: createMockSession(["platform_operator"])
  });
}

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: "copy",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn(),
    getData: vi.fn((type: string) => data.get(type) ?? ""),
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
    setDragImage: vi.fn()
  } as unknown as DataTransfer;
}

describe("SaaS Administration M3 Workflow editor (C5)", () => {
  it("открывает вкладку и схемы для роли platform_operator", async () => {
    const api = createWorkflowOperatorApi();
    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    expect(
      await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workflow" })).toBeInTheDocument();
  });

  it("скрывает функционал редактора для администратора без роли platform_operator", async () => {
    const api = createMockSaasAdminApiClient();
    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    expect(
      await screen.findByText("Раздел Workflow доступен только оператору платформы.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Открыть Workflow Автоответчик обращений" })
    ).not.toBeInTheDocument();
  });

  it("показывает безопасную палитру, редактирует узел и сохраняет схему новой версией", async () => {
    const api = createWorkflowOperatorApi();
    const createVersion = vi.spyOn(api.workflows, "createVersion");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    // Список Workflow загружается и авто-выбирает первый сценарий.
    expect(
      await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" })
    ).toBeInTheDocument();

    // Палитра ограничена каноническим набором C5 (ТЗ §13.13).
    const paletteButtons = await screen.findAllByRole("button", { name: /^Добавить узел:/ });
    expect(paletteButtons).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Добавить узел: Субсхема" })).toBeInTheDocument();

    // Узел вызова Backend API помечен как изменяющий данные (ТЗ §13.5).
    await user.click(screen.getByRole("button", { name: "Узел Создать тикет" }));
    expect(within(screen.getByRole("region", { name: "Редактор схемы Workflow" })).getByText("Изменяет данные")).toBeInTheDocument();

    // Добавляем узел ветвления и переименовываем его в панели свойств.
    await user.click(screen.getByRole("button", { name: "Добавить узел: Ветвление" }));
    const labelInput = await screen.findByLabelText("Метка узла");
    expect(labelInput).toHaveValue("Ветвление");
    await user.clear(labelInput);
    await user.type(labelInput, "Проверка бюджета");

    // Сохраняем как новую версию (ТЗ §13.10) без активации.
    await user.click(screen.getByRole("button", { name: "Сохранить как новую версию" }));

    await waitFor(() => {
      expect(createVersion).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          activate: false,
          schema: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({ type: "branch", label: "Проверка бюджета" })
            ])
          })
        })
      );
    });

    expect(
      await screen.findByText("Сохранена версия v3. Выполняющиеся инстансы не затронуты.")
    ).toBeInTheDocument();
  });

  it("сохраняет sub_schema как ссылку на выбранный slug без bodyGraph", async () => {
    const api = createWorkflowOperatorApi();
    const createVersion = vi.spyOn(api.workflows, "createVersion");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });
    await user.click(await screen.findByRole("button", { name: "Добавить узел: Субсхема" }));
    await user.selectOptions(await screen.findByLabelText("Субсхема"), "support-common-context");
    await user.click(screen.getByRole("button", { name: "Сохранить как новую версию" }));

    await waitFor(() => {
      expect(createVersion).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          schema: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                type: "sub_schema",
                config: { subSchemaSlug: "support-common-context" }
              })
            ])
          })
        })
      );
    });
  });

  it("добавляет узел перетаскиванием на canvas и поддерживает bodyGraph, черновик, публикацию, сброс и тестовый запуск", async () => {
    const api = createWorkflowOperatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const promoteDraft = vi.spyOn(api.workflows, "promoteDraft");
    const resetDraft = vi.spyOn(api.workflows, "resetDraft");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });

    const source = await screen.findByRole("button", { name: "Добавить узел: Transform Node" });
    const canvas = screen.getByRole("group", { name: "Схема узлов и связей" });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(canvas, { clientX: 360, clientY: 220, dataTransfer });
    fireEvent.drop(canvas, { clientX: 360, clientY: 220, dataTransfer });

    await user.click(await screen.findByRole("button", { name: "Узел Transform Node" }));
    await user.click(screen.getByRole("button", { name: "Открыть bodyGraph" }));
    expect(await screen.findByText("Корневая схема / Transform Node")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Добавить узел: Transform Node" }));
    const fromSelect = screen.getByLabelText("Из узла");
    const toSelect = screen.getByLabelText("В узел");
    await user.selectOptions(
      fromSelect,
      within(fromSelect).getByRole("option", { name: "Подготовить контекст" })
    );
    await user.selectOptions(
      toSelect,
      within(toSelect).getByRole("option", { name: "Transform Node" })
    );
    await user.click(screen.getByRole("button", { name: "Добавить связь" }));
    await user.click(screen.getByRole("button", { name: "Вернуться к родительской схеме" }));
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText("Черновик сохранён.")).toBeInTheDocument();
    await waitFor(() => {
      expect(saveDraft).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          schema: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                type: "transform",
                config: expect.objectContaining({
                  bodyGraph: expect.objectContaining({
                    nodes: expect.arrayContaining([
                      expect.objectContaining({ type: "transform" })
                    ])
                  })
                })
              })
            ])
          })
        })
      );
    });

    await user.click(screen.getByRole("button", { name: "Тестовый запуск" }));
    const runLog = await screen.findByRole("region", { name: "Лог тестового запуска" });
    expect(within(runLog).getByText("workflow.test.completed")).toBeInTheDocument();
    expect(within(runLog).getAllByText("bodyGraph.completed").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Сбросить черновик" }));
    await waitFor(() => {
      expect(resetDraft).toHaveBeenCalledWith("wf-support-autoresponder");
    });
    expect(await screen.findByText("Черновик сброшен к активной версии v2.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Добавить узел: Ветвление" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать черновик" }));
    await waitFor(() => {
      expect(promoteDraft).toHaveBeenCalledWith("wf-support-autoresponder");
    });
    expect(await screen.findByText("Черновик опубликован как активная версия.")).toBeInTheDocument();
  });

  it("загружает сохранённый черновик после remount страницы", async () => {
    const api = createWorkflowOperatorApi();
    const firstRender = renderRoute("/workflow", {
      api,
      realtime: createMockC7RealtimeClient([])
    });

    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });
    await firstRender.user.click(
      await screen.findByRole("button", { name: "Добавить узел: Ветвление" }),
    );
    const labelInput = await screen.findByLabelText("Метка узла");
    await firstRender.user.clear(labelInput);
    await firstRender.user.type(labelInput, "Проверка SLA");
    await firstRender.user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText("Черновик сохранён.")).toBeInTheDocument();

    firstRender.unmount();

    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });
    expect(await screen.findByRole("button", { name: "Узел Проверка SLA" })).toBeInTheDocument();
    expect(await screen.findByText("Черновик сохранён")).toBeInTheDocument();
  });

  it("импортирует Workflow JSON в persisted draft после diff-подтверждения", async () => {
    const api = createWorkflowOperatorApi();
    const importWorkflow = vi.spyOn(api.workflows, "importWorkflow");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const importedSchema: WorkflowSchema = {
      schema_version: "1.0.0",
      entry: "node-wait-event-import",
      nodes: [
        {
          id: "node-wait-event-import",
          type: "wait-event",
          label: "Входящее сообщение",
          config: { event_type: "channel.message_received" },
          position: { x: 40, y: 40 }
        }
      ],
      connections: []
    };
    const file = new File(
      [
        JSON.stringify({
          contract: "C5.WorkflowSchemaExport",
          version: "1.0.0",
          exported_at: "2026-07-03T11:17:00.000Z",
          workflow: {
            id: "wf-support-autoresponder",
            name: "Автоответчик обращений",
            version_id: "wfv-support-2",
            version_no: 2
          },
          schema: importedSchema
        })
      ],
      "workflow.json",
      { type: "application/json" }
    );

    const { container } = renderRoute("/workflow", {
      api,
      realtime: createMockC7RealtimeClient([])
    });
    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });
    await screen.findByRole("button", { name: "Импорт JSON" });

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Файл импорта Workflow JSON"]'
    );
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Узлы:"));
      expect(importWorkflow).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          schema: importedSchema,
          target: "draft"
        })
      );
    });
    expect(await screen.findByText("JSON импортирован и сохранён как черновик.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Узел Входящее сообщение" })).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("импортирует Workflow JSON как новую версию после выбора цели импорта", async () => {
    const api = createWorkflowOperatorApi();
    const importWorkflow = vi.spyOn(api.workflows, "importWorkflow");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const importedSchema: WorkflowSchema = {
      schema_version: "1.0.0",
      entry: "node-version-import",
      nodes: [
        {
          id: "node-version-import",
          type: "wait-event",
          label: "Импортированная версия",
          config: { event_type: "channel.message_received" },
          position: { x: 80, y: 80 }
        }
      ],
      connections: []
    };
    const file = new File(
      [
        JSON.stringify({
          contract: "C5.WorkflowSchemaExport",
          version: "1.0.0",
          exported_at: "2026-07-03T11:17:00.000Z",
          workflow: {
            id: "wf-support-autoresponder",
            name: "Автоответчик обращений",
            version_id: "wfv-support-2",
            version_no: 2
          },
          schema: importedSchema
        })
      ],
      "workflow-version.json",
      { type: "application/json" }
    );

    const { container, user } = renderRoute("/workflow", {
      api,
      realtime: createMockC7RealtimeClient([])
    });
    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });
    await screen.findByRole("button", { name: "Импорт JSON" });
    await waitFor(() => {
      expect(screen.getByLabelText("Цель импорта")).toBeEnabled();
    });
    await user.selectOptions(screen.getByLabelText("Цель импорта"), "version");
    await waitFor(() => {
      expect(screen.getByLabelText("Цель импорта")).toHaveValue("version");
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Файл импорта Workflow JSON"]'
    );
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("как новую версию"));
      expect(importWorkflow).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          schema: importedSchema,
          target: "version"
        })
      );
    });
    expect(await screen.findByText(/JSON импортирован как новая версия v/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Узел Импортированная версия" })
    ).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("включает/отключает Workflow и переключает активную версию по умолчанию", async () => {
    const api = createWorkflowOperatorApi();
    const updateWorkflow = vi.spyOn(api.workflows, "updateWorkflow");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" });

    // Включение/отключение Workflow (ТЗ §16.7).
    await user.click(screen.getByRole("button", { name: "Отключить" }));
    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalledWith("wf-support-autoresponder", { enabled: false });
    });
    expect(await screen.findByText("Workflow отключен")).toBeInTheDocument();

    // Выбор активной версии по умолчанию не затрагивает выполняющиеся инстансы (ТЗ §13.10).
    await user.selectOptions(
      screen.getByLabelText("Активная версия по умолчанию"),
      "wfv-support-1"
    );
    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalledWith("wf-support-autoresponder", {
        default_version_id: "wfv-support-1"
      });
    });
    expect(
      await screen.findByText("Активная версия обновлена. Выполняющиеся инстансы не затронуты.")
    ).toBeInTheDocument();
  });

  it("открывает диагностику инстанса из истории исполнения", async () => {
    const api = createWorkflowOperatorApi();
    const getInstance = vi.spyOn(api.workflows, "getInstance");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    const historyPanel = await screen.findByRole("region", { name: "История исполнения Workflow" });
    await user.click(
      await within(historyPanel).findByRole("button", {
        name: "Диагностика инстанса wfi-support-1001"
      })
    );

    await waitFor(() => {
      expect(getInstance).toHaveBeenCalledWith("wf-support-autoresponder", "wfi-support-1001");
    });
    expect(
      await within(historyPanel).findByText("Backend API создал тикет T-1001.")
    ).toBeInTheDocument();
  });
});
