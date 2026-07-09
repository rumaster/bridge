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

/**
 * Узлы добавляются только перетаскиванием на холст (ТЗ §13.13, требование 3):
 * клик по элементу палитры больше не создаёт узел, поэтому тесты используют
 * последовательность dragStart → dragOver → drop.
 */
function dragNodeToCanvas(nodeLabel: string, clientX = 360, clientY = 220) {
  const source = screen.getByRole("button", { name: `Добавить узел: ${nodeLabel}` });
  const canvas = screen.getByRole("group", { name: "Схема узлов и связей" });
  const dataTransfer = createDataTransfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(canvas, { clientX, clientY, dataTransfer });
  fireEvent.drop(canvas, { clientX, clientY, dataTransfer });
}

/** Дожидается загрузки и авто-выбора первой схемы Workflow (заголовок в панели «Информация о схеме»). */
function findSelectedWorkflowHeading() {
  return screen.findByRole("heading", { name: "Автоответчик обращений" });
}

describe("SaaS Administration M3 Workflow editor (C5)", () => {
  it("открывает вкладку и схемы для роли platform_operator", async () => {
    const api = createWorkflowOperatorApi();
    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    expect(await findSelectedWorkflowHeading()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workflow" })).toBeInTheDocument();
  });

  it("скрывает функционал редактора для администратора без роли platform_operator", async () => {
    const api = createMockSaasAdminApiClient();
    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    expect(
      await screen.findByText("Раздел Workflow доступен только оператору платформы.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Автоответчик обращений" })
    ).not.toBeInTheDocument();
  });

  it("показывает безопасную палитру, редактирует узел и сохраняет черновик в рабочую версию", async () => {
    const api = createWorkflowOperatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const promoteDraft = vi.spyOn(api.workflows, "promoteDraft");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    // Схема загружается и авто-выбирается в верхней панели.
    expect(await findSelectedWorkflowHeading()).toBeInTheDocument();

    // Палитра ограничена каноническим набором C5 (ТЗ §13.13).
    const paletteButtons = await screen.findAllByRole("button", { name: /^Добавить узел:/ });
    expect(paletteButtons).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Добавить узел: Субсхема" })).toBeInTheDocument();

    // Узел вызова Backend API помечен как изменяющий данные (ТЗ §13.5).
    await user.click(screen.getByRole("button", { name: "Узел Создать тикет" }));
    expect(
      within(screen.getByRole("region", { name: "Редактор схемы Workflow" })).getByText("Изменяет данные")
    ).toBeInTheDocument();

    // Добавляем узел ветвления перетаскиванием и переименовываем его в панели свойств.
    dragNodeToCanvas("Ветвление");
    const labelInput = await screen.findByLabelText("Метка узла");
    expect(labelInput).toHaveValue("Ветвление");
    await user.clear(labelInput);
    await user.type(labelInput, "Проверка бюджета");

    // Иконочный тулбар: «Сохранить черновик в рабочую версию» = persist draft + promote (ТЗ §13.10).
    await user.click(screen.getByRole("button", { name: "Сохранить черновик в рабочую версию" }));

    await waitFor(() => {
      expect(saveDraft).toHaveBeenCalledWith(
        "wf-support-autoresponder",
        expect.objectContaining({
          schema: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({ type: "branch", label: "Проверка бюджета" })
            ])
          })
        })
      );
      expect(promoteDraft).toHaveBeenCalledWith("wf-support-autoresponder");
    });

    expect(await screen.findByText("Черновик сохранён в рабочую версию.")).toBeInTheDocument();
  });

  it("сохраняет sub_schema как ссылку на выбранный slug без bodyGraph", async () => {
    const api = createWorkflowOperatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await findSelectedWorkflowHeading();
    await screen.findByRole("button", { name: "Добавить узел: Субсхема" });
    dragNodeToCanvas("Субсхема");
    await user.selectOptions(await screen.findByLabelText("Субсхема"), "support-common-context");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик в рабочую версию" }));

    await waitFor(() => {
      expect(saveDraft).toHaveBeenCalledWith(
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

  it("поддерживает bodyGraph, автосохранение перед тестом, перезагрузку и сохранение в рабочую версию", async () => {
    const api = createWorkflowOperatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const promoteDraft = vi.spyOn(api.workflows, "promoteDraft");
    const resetDraft = vi.spyOn(api.workflows, "resetDraft");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await findSelectedWorkflowHeading();

    dragNodeToCanvas("Transform Node");
    await user.click(await screen.findByRole("button", { name: "Узел Transform Node" }));
    await user.click(screen.getByRole("button", { name: "Открыть bodyGraph" }));
    expect(await screen.findByText("Корневая схема / Transform Node")).toBeInTheDocument();

    dragNodeToCanvas("Transform Node");
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

    // Тест открывается модальным окном; запуск автосохраняет черновик с bodyGraph.
    await user.click(screen.getByRole("button", { name: "Тестовый запуск" }));
    await user.click(await screen.findByRole("button", { name: "Запустить тест" }));

    const runLog = await screen.findByRole("region", { name: "Лог тестового запуска" });
    expect(within(runLog).getByText("workflow.test.completed")).toBeInTheDocument();
    expect(within(runLog).getAllByText("bodyGraph.completed").length).toBeGreaterThan(0);
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
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Закрыть" }));

    // Перезагрузка черновика из рабочей версии (иконка тулбара) → resetDraft.
    await user.click(screen.getByRole("button", { name: "Перезагрузить черновик из рабочей версии" }));
    await waitFor(() => {
      expect(resetDraft).toHaveBeenCalledWith("wf-support-autoresponder");
    });
    expect(
      await screen.findByText("Черновик перезагружен из рабочей версии v2.")
    ).toBeInTheDocument();

    // Правка и сохранение в рабочую версию (promote).
    dragNodeToCanvas("Ветвление");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик в рабочую версию" }));
    await waitFor(() => {
      expect(promoteDraft).toHaveBeenCalledWith("wf-support-autoresponder");
    });
    expect(await screen.findByText("Черновик сохранён в рабочую версию.")).toBeInTheDocument();
  });

  it("создаёт субсхему через диалог и переходит к её редактированию", async () => {
    const api = createWorkflowOperatorApi();
    const createSubschema = vi.spyOn(api.workflows, "createSubschema");
    const updateSubschema = vi.spyOn(api.workflows, "updateSubschema");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await findSelectedWorkflowHeading();

    await user.click(screen.getByRole("button", { name: "Создать субсхему" }));
    const dialog = await screen.findByRole("dialog", { name: "Создать субсхему" });
    await user.type(within(dialog).getByLabelText("Slug (имя схемы)"), "onboarding-flow");
    await user.type(within(dialog).getByLabelText("Название"), "Онбординг");
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(createSubschema).toHaveBeenCalledWith({ slug: "onboarding-flow", name: "Онбординг" });
    });

    // Редактор переходит в режим субсхемы: заголовок и кнопка возврата к Workflow.
    expect(await screen.findByText("Субсхема: Онбординг")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Вернуться к Workflow" })).toBeInTheDocument();

    // Правим существующий узел субсхемы и сохраняем в рабочую версию → updateSubschema.
    await user.click(await screen.findByRole("button", { name: "Узел Подготовить контекст" }));
    const subLabel = await screen.findByLabelText("Метка узла");
    await user.clear(subLabel);
    await user.type(subLabel, "Собрать контекст");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик в рабочую версию" }));
    await waitFor(() => {
      expect(updateSubschema).toHaveBeenCalledWith(
        expect.stringContaining("wfs-"),
        expect.objectContaining({
          schema: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({ type: "transform", label: "Собрать контекст" })
            ])
          })
        })
      );
    });
    expect(await screen.findByText("Субсхема «Онбординг» сохранена.")).toBeInTheDocument();
  });

  it("загружает сохранённый черновик после remount страницы", async () => {
    const api = createWorkflowOperatorApi();
    const firstRender = renderRoute("/workflow", {
      api,
      realtime: createMockC7RealtimeClient([])
    });

    await findSelectedWorkflowHeading();
    await screen.findByRole("button", { name: "Добавить узел: Ветвление" });
    dragNodeToCanvas("Ветвление");
    const labelInput = await screen.findByLabelText("Метка узла");
    await firstRender.user.clear(labelInput);
    await firstRender.user.type(labelInput, "Проверка SLA");

    // Черновик автосохраняется при размонтировании редактора (ТЗ §13.10).
    firstRender.unmount();

    renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });
    expect(await screen.findByRole("button", { name: "Узел Проверка SLA" })).toBeInTheDocument();
    expect(await screen.findByText("Есть незафиксированный черновик")).toBeInTheDocument();
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
    await findSelectedWorkflowHeading();
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

  it("включает/отключает Workflow и переключает активную версию по умолчанию", async () => {
    const api = createWorkflowOperatorApi();
    const updateWorkflow = vi.spyOn(api.workflows, "updateWorkflow");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    await findSelectedWorkflowHeading();

    // Включение/отключение Workflow из панели «Информация о схеме» (ТЗ §16.7).
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

  it("открывает диагностику инстанса из модального окна истории исполнения", async () => {
    const api = createWorkflowOperatorApi();
    const getInstance = vi.spyOn(api.workflows, "getInstance");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    // История исполнения открывается модальным окном из иконочного тулбара (ТЗ §13, требование 6).
    await findSelectedWorkflowHeading();
    await user.click(screen.getByRole("button", { name: "История исполнения" }));

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
