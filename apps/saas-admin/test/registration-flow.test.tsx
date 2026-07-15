import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockSaasAdminServices } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";
import { SAAS_ADMIN_SESSION_STORAGE_KEY } from "../src/state/auth";
import type { AdminSession } from "../src/api/client/types";

function renderRoute(path: string) {
  const router = createSaasAdminRouter({
    initialEntries: [path],
    services: createMockSaasAdminServices({ authenticated: false })
  });

  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("Self-service organization registration", () => {
  it("reaches the registration page from the login page", async () => {
    const { user } = renderRoute("/login");

    expect(await screen.findByRole("heading", { name: "Вход администратора" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Зарегистрировать" }));

    expect(
      await screen.findByRole("heading", { name: "Регистрация организации" })
    ).toBeInTheDocument();
  });

  it("runs form -> Telegram deep link -> code and signs the new administrator in", async () => {
    const { user } = renderRoute("/register");

    expect(
      await screen.findByRole("heading", { name: "Регистрация организации" })
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Telegram-имя"), "@new_admin");
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Название организации"), "Acme Support");
    await user.click(screen.getByRole("button", { name: "Продолжить" }));

    // Код нельзя отправить сразу: сначала пользователь обязан нажать Start у бота,
    // иначе Telegram не даст боту написать ему первым.
    const botLink = await screen.findByRole("link", { name: /Открыть бота в Telegram/ });
    expect(botLink).toHaveAttribute("href", expect.stringContaining("?start="));

    await user.type(await screen.findByLabelText("Код подтверждения"), "000000");
    await user.click(screen.getByRole("button", { name: "Создать организацию" }));

    await waitFor(() => {
      const storedSession = JSON.parse(
        window.localStorage.getItem(SAAS_ADMIN_SESSION_STORAGE_KEY) ?? "null"
      ) as AdminSession | null;
      expect(storedSession?.roles).toContain("administrator");
    });
  });

  it("keeps the user on the form and reports the reason when the request is rejected", async () => {
    const { user } = renderRoute("/register");

    await screen.findByRole("heading", { name: "Регистрация организации" });

    // Пустое название организации не проходит валидацию мок-клиента.
    await user.type(screen.getByLabelText("Telegram-имя"), "@new_admin");
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Продолжить" }));

    expect(screen.getByLabelText("Название организации")).toBeInTheDocument();
  });
});
