import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockManagerWorkspaceServices } from "../src/api/mocks/client";
import { createManagerWorkspaceRouter } from "../src/routing/router";

function renderRoute(path: string) {
  const router = createManagerWorkspaceRouter({
    initialEntries: [path],
    services: createMockManagerWorkspaceServices()
  });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("Manager Workspace M0 shell", () => {
  it("renders the shell and redirects the root route to the conversation queue", async () => {
    renderRoute("/");

    expect(
      await screen.findByRole("heading", { name: "Очередь диалогов" })
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Рабочее место менеджера" })).toBeInTheDocument();
  });

  it("renders the login stub and authenticates against the mocked C3.auth contract", async () => {
    const { user } = renderRoute("/login");

    expect(await screen.findByRole("heading", { name: "Вход менеджера" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Telegram username"));
    await user.type(screen.getByLabelText("Telegram username"), "manager_demo");
    await user.click(screen.getByRole("button", { name: "Запросить код" }));

    expect(await screen.findByText("Код отправлен в Telegram")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => {
      expect(screen.getByText(/Демо Менеджер/)).toBeInTheDocument();
    });
  });

  it("renders lazy route placeholders for queue, dialog and notifications", async () => {
    const queue = renderRoute("/queue");
    expect(await screen.findByRole("heading", { name: "Очередь диалогов" })).toBeInTheDocument();
    expect(await screen.findByText("Анна Петрова")).toBeInTheDocument();
    queue.unmount();

    const dialog = renderRoute("/dialogs/conv-1");
    expect(await screen.findByRole("heading", { name: "Диалог" })).toBeInTheDocument();
    expect(await screen.findByText("Хочу уточнить статус заказа")).toBeInTheDocument();
    dialog.unmount();

    renderRoute("/notifications");
    expect(await screen.findByRole("heading", { name: "Уведомления" })).toBeInTheDocument();
    expect(await screen.findByText("Новый диалог в очереди")).toBeInTheDocument();
  });
});
