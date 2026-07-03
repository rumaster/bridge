import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockSaasAdminServices } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";

function renderRoute(path: string, authenticated = true) {
  const router = createSaasAdminRouter({
    initialEntries: [path],
    services: createMockSaasAdminServices({
      authenticated
    })
  });

  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration M0 shell", () => {
  it("renders the protected shell and redirects the root route to overview", async () => {
    renderRoute("/");

    expect(
      await screen.findByRole("heading", { name: "Административная панель" })
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Администрирование организации" })).toBeInTheDocument();
    expect(screen.getAllByText("Демо Организация").length).toBeGreaterThan(0);
  });

  it("guards protected routes and returns to the requested section after Telegram auth", async () => {
    const { user } = renderRoute("/organization", false);

    expect(await screen.findByRole("heading", { name: "Вход администратора" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Администрирование организации" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Telegram-имя"), "@admin_demo");
    await user.click(screen.getByRole("button", { name: "Отправить код" }));
    await user.type(await screen.findByLabelText("Одноразовый код"), "000000");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Организация и конфигурация" })).toBeInTheDocument();
    });
  });

  it("renders lazy skeleton sections for future administration modules", async () => {
    const channels = renderRoute("/channels");
    expect(await screen.findByRole("heading", { name: "Каналы связи" })).toBeInTheDocument();
    channels.unmount();

    const knowledge = renderRoute("/knowledge");
    expect(await screen.findByRole("heading", { name: "Knowledge Base" })).toBeInTheDocument();
    knowledge.unmount();

    const workflow = renderRoute("/workflow");
    expect(await screen.findByRole("heading", { name: "Workflow" })).toBeInTheDocument();
    workflow.unmount();

    renderRoute("/broadcast");
    expect(await screen.findByRole("heading", { name: "Broadcast" })).toBeInTheDocument();
  });
});
