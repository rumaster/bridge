import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration M3 Workflow editor (C5)", () => {
  it("показывает безопасную палитру, редактирует узел и сохраняет схему новой версией", async () => {
    const api = createMockSaasAdminApiClient();
    const createVersion = vi.spyOn(api.workflows, "createVersion");
    const { user } = renderRoute("/workflow", { api, realtime: createMockC7RealtimeClient([]) });

    // Список Workflow загружается и авто-выбирает первый сценарий.
    expect(
      await screen.findByRole("button", { name: "Открыть Workflow Автоответчик обращений" })
    ).toBeInTheDocument();

    // Палитра ограничена безопасным набором узлов (ТЗ §13.13) — ровно 6 типов.
    const paletteButtons = await screen.findAllByRole("button", { name: /^Добавить узел:/ });
    expect(paletteButtons).toHaveLength(6);

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

  it("включает/отключает Workflow и переключает активную версию по умолчанию", async () => {
    const api = createMockSaasAdminApiClient();
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
    const api = createMockSaasAdminApiClient();
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
