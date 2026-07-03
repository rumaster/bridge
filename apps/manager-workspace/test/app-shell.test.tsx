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

describe("Manager Workspace M1 flow", () => {
  it("renders the shell and redirects the root route to the conversation queue", async () => {
    renderRoute("/");

    expect(
      await screen.findByRole("heading", { name: "Очередь диалогов" })
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Рабочее место менеджера" })).toBeInTheDocument();
  });

  it("authenticates against the C3.auth contract", async () => {
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

  it("renders queue rows from C3.conversations and filters them by C3.clients data", async () => {
    const queue = renderRoute("/queue");

    expect(await screen.findByRole("heading", { name: "Очередь диалогов" })).toBeInTheDocument();
    expect(await screen.findByText("Анна Петрова")).toBeInTheDocument();
    expect(await screen.findByText("Илья Смирнов")).toBeInTheDocument();

    await queue.user.type(screen.getByLabelText("Поиск клиента"), "Илья");

    await waitFor(() => {
      expect(screen.queryByText("Анна Петрова")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Илья Смирнов")).toBeInTheDocument();
  });

  it("renders dialog history, client card and sends a manager reply", async () => {
    const { user } = renderRoute("/dialogs/conv-1");

    expect(await screen.findByRole("heading", { name: "Диалог" })).toBeInTheDocument();
    expect(await screen.findByText("Хочу уточнить статус заказа")).toBeInTheDocument();
    expect(await screen.findByText("order-status.png")).toBeInTheDocument();
    expect(await screen.findByText("web-chat:anna")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Ответ менеджера"), "Статус заказа обновили");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Статус заказа обновили")).toBeInTheDocument();
    expect((await screen.findAllByText("sent")).length).toBeGreaterThan(0);
  });

  it("covers the manager e2e path in memory: queue, history, reply", async () => {
    const { user } = renderRoute("/queue");

    expect(await screen.findByRole("heading", { name: "Очередь диалогов" })).toBeInTheDocument();

    const [firstConversation] = await screen.findAllByRole("link", { name: "Открыть" });
    await user.click(firstConversation);

    expect(await screen.findByRole("heading", { name: "Диалог" })).toBeInTheDocument();
    expect(await screen.findByText("Анна Петрова")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Ответ менеджера"), "Ответ отправлен из рабочего места");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Ответ отправлен из рабочего места")).toBeInTheDocument();
  });

  it("renders notifications route from the existing C10 mock", async () => {
    renderRoute("/notifications");
    expect(await screen.findByRole("heading", { name: "Уведомления" })).toBeInTheDocument();
    expect(await screen.findByText("Новый диалог в очереди")).toBeInTheDocument();
  });
});
