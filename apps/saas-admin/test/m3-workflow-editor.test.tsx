import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { createMockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

/**
 * Редактор схем Workflow 2.0 (этап 7) — покрытие НОВОЙ страницы на @xyflow/react.
 *
 * Старая спека `m3-workflow.test.tsx` целиком снята с прогона: она пинит разметку
 * прежнего редактора и проверяет четыре возможности, которые ещё не перенесены
 * (импорт/экспорт, диалог субсхемы, версии, диагностика инстансов). Здесь —
 * сценарии, которые новая страница УЖЕ реализует: палитра из контракта, добавление
 * узла, автосохранение драфта, тест-прогон.
 *
 * Три ранее снятых `it.skip` (палитра, sub_schema по slug, автосейв с
 * перезагрузкой) возвращаются сюда по смыслу, а не переснимаются на старой
 * разметке, которую этап 7 удаляет.
 */

function operatorApi() {
  return createMockSaasAdminApiClient({ session: createMockSession(["platform_operator"]) });
}

function renderRoute(path: string, services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return { user: userEvent.setup(), ...render(<RouterProvider router={router} />) };
}

async function waitForEditor() {
  // Заголовок выбранной схемы появляется после загрузки списка и её драфта.
  return screen.findByRole("heading", { name: "Автоответчик обращений" });
}

describe("Workflow editor 2.0 (этап 7)", () => {
  it("показывает палитру из контракта: безопасные типы, backend-api помечен «Изменяет данные»", async () => {
    renderRoute("/workflow", { api: operatorApi() });
    await waitForEditor();

    // Палитра ограничена каноническим набором C5.
    expect(screen.getByRole("button", { name: /Ветвление/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transform/ })).toBeInTheDocument();

    // Единственный узел, меняющий данные (ТЗ §13.5), помечен визуально.
    const backendApiButton = screen.getByRole("button", { name: /Вызов Backend API/ });
    expect(within(backendApiButton).getByText("Изменяет данные")).toBeInTheDocument();

    // start/end — только для субсхем: в обычном Workflow их в палитре нет.
    expect(screen.queryByRole("button", { name: /^Начало субсхемы/ })).not.toBeInTheDocument();
  });

  it("добавляет узел из палитры и открывает его свойства", async () => {
    const { user } = renderRoute("/workflow", { api: operatorApi() });
    await waitForEditor();

    await user.click(screen.getByRole("button", { name: /Ветвление/ }));

    // Панель свойств открылась на новом узле: селектбокс оператора ветвления —
    // из контракта, а не свободный ввод.
    expect(await screen.findByLabelText("Оператор")).toBeInTheDocument();
    // Появился незафиксированный черновик.
    expect(screen.getByText("Есть незафиксированный черновик")).toBeInTheDocument();
  });

  it("автосохраняет черновик при уходе из редактора (unmount)", async () => {
    const api = operatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const { user, unmount } = renderRoute("/workflow", { api });
    await waitForEditor();

    await user.click(screen.getByRole("button", { name: /Transform/ }));
    expect(saveDraft).not.toHaveBeenCalled();

    // Уход из редактора = автосохранение: работа оператора не теряется.
    unmount();
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const [, payload] = saveDraft.mock.calls[0];
    expect(payload.schema.nodes.some((node) => node.type === "transform")).toBe(true);
  });

  it("«Сохранить» = promote: черновик копируется в неизменяемую версию", async () => {
    const api = operatorApi();
    const saveDraft = vi.spyOn(api.workflows, "saveDraft");
    const promoteDraft = vi.spyOn(api.workflows, "promoteDraft");
    const { user } = renderRoute("/workflow", { api });
    await waitForEditor();

    await user.click(screen.getByRole("button", { name: /Ветвление/ }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(promoteDraft).toHaveBeenCalledTimes(1));
    // Сначала сохраняется драфт, затем promote — порядок важен.
    expect(saveDraft).toHaveBeenCalled();
    expect(await screen.findByText(/сохранена как версия/)).toBeInTheDocument();
  });

  it("узел sub_schema хранит ссылку на slug из списка активных субсхем", async () => {
    const { user } = renderRoute("/workflow", { api: operatorApi() });
    await waitForEditor();

    await user.click(screen.getByRole("button", { name: /Субсхема/ }));

    // Субсхема выбирается из списка, а не вводится строкой: узел хранит только slug.
    const select = await screen.findByLabelText("Субсхема");
    expect(within(select).getByRole("option", { name: /support-common-context/ })).toBeInTheDocument();
  });

  it("тест-прогон недоступен без узла «Ожидание события»", async () => {
    // Прогон начинается с точки входа схемы 2.0. У «Автоответчика» wait-event есть
    // в опубликованной версии, но открытый драфт пуст — панель это объясняет.
    renderRoute("/workflow", { api: operatorApi() });
    await waitForEditor();

    expect(await screen.findByTestId("workflow-test-no-entry")).toBeInTheDocument();
  });

  it("скрывает редактор для роли без прав оператора платформы", async () => {
    const api = createMockSaasAdminApiClient({ session: createMockSession(["administrator"]) });
    renderRoute("/workflow", { api });

    expect(
      await screen.findByText("Раздел Workflow доступен только оператору платформы.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ветвление/ })).not.toBeInTheDocument();
  });
});
