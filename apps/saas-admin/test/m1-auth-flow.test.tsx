import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockSaasAdminServices } from "../src/api/mocks/client";
import { mockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import { SAAS_ADMIN_SESSION_STORAGE_KEY } from "../src/state/auth";
import type { AdminSession } from "../src/api/client/types";

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

describe("SaaS Administration M1 auth flow", () => {
  it("runs Telegram username -> one-time code login, stores the session and returns to the requested page", async () => {
    const { user } = renderRoute("/organization", false);

    expect(await screen.findByRole("heading", { name: "Вход администратора" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Telegram-имя"), "@admin_demo");
    await user.click(screen.getByRole("button", { name: "Отправить код" }));

    expect(await screen.findByText(/Код отправлен в Telegram/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Одноразовый код"), "000000");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Организация и конфигурация" })).toBeInTheDocument();
    });

    const storedSession = JSON.parse(
      window.localStorage.getItem(SAAS_ADMIN_SESSION_STORAGE_KEY) ?? "null"
    ) as AdminSession | null;
    expect(storedSession?.roles).toContain("administrator");
  });

  it("uses the stored session immediately and refreshes it through C3.auth session", async () => {
    window.localStorage.setItem(
      SAAS_ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        ...mockSession,
        user: {
          ...mockSession.user,
          displayName: "Администратор из сохранённой сессии"
        }
      } satisfies AdminSession)
    );

    renderRoute("/overview", true);

    const topbar = await screen.findByRole("banner");
    expect(within(topbar).getByText("Демо Организация")).toBeInTheDocument();

    await waitFor(() => {
      const storedSession = JSON.parse(
        window.localStorage.getItem(SAAS_ADMIN_SESSION_STORAGE_KEY) ?? "null"
      ) as AdminSession | null;
      expect(storedSession?.user.displayName).toBe(mockSession.user.displayName);
    });
  });
});
