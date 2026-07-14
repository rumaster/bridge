import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderUsers(services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: ["/users"], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration — управление менеджерами", () => {
  it("рендерит пользователей организации и запрещает действия над собой", async () => {
    const api = createMockSaasAdminApiClient();
    renderUsers({ api, realtime: createMockC7RealtimeClient([]) });

    const selfRow = await screen.findByRole("row", { name: /Демо Администратор/ });
    // Действующий администратор не может заблокировать себя или сменить свою роль.
    expect(within(selfRow).getByRole("button", { name: "Заблокировать" })).toBeDisabled();
    expect(within(selfRow).getByRole("combobox", { name: /Роль Демо Администратор/ })).toBeDisabled();

    const managerRow = screen.getByRole("row", { name: /Менеджер Ольга/ });
    expect(within(managerRow).getByRole("button", { name: "Заблокировать" })).toBeEnabled();
  });

  it("создаёт менеджера через форму добавления", async () => {
    const api = createMockSaasAdminApiClient();
    const createUser = vi.spyOn(api.users, "createUser");
    const { user } = renderUsers({ api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Пользователи и роли" });
    await user.type(screen.getByLabelText("Имя"), "Иван Петров");
    await user.type(screen.getByLabelText("Email (необязательно)"), "ivan@example.com");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByRole("row", { name: /Иван Петров/ })).toBeInTheDocument();
    expect(createUser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ displayName: "Иван Петров", roleCodes: ["manager"] })
    );
  });

  it("блокирует менеджера и обновляет статус", async () => {
    const api = createMockSaasAdminApiClient();
    const patchUser = vi.spyOn(api.users, "patchUser");
    const { user } = renderUsers({ api, realtime: createMockC7RealtimeClient([]) });

    const managerRow = await screen.findByRole("row", { name: /Менеджер Ольга/ });
    await user.click(within(managerRow).getByRole("button", { name: "Заблокировать" }));

    await waitFor(() => {
      expect(within(managerRow).getByText("Заблокирован")).toBeInTheDocument();
    });
    expect(within(managerRow).getByRole("button", { name: "Разблокировать" })).toBeInTheDocument();
    expect(patchUser).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000301",
      expect.objectContaining({ status: "blocked" })
    );
  });

  it("повышает менеджера до администратора сменой роли", async () => {
    const api = createMockSaasAdminApiClient();
    const patchUser = vi.spyOn(api.users, "patchUser");
    const { user } = renderUsers({ api, realtime: createMockC7RealtimeClient([]) });

    const managerRow = await screen.findByRole("row", { name: /Менеджер Ольга/ });
    await user.selectOptions(
      within(managerRow).getByRole("combobox", { name: /Роль Менеджер Ольга/ }),
      "administrator"
    );

    expect(patchUser).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000301",
      expect.objectContaining({ roleCodes: ["administrator"] })
    );
  });

  it("создаёт приглашение и показывает токен", async () => {
    const api = createMockSaasAdminApiClient();
    const { user } = renderUsers({ api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Пользователи и роли" });
    await user.type(screen.getByLabelText("Email"), "invited@example.com");
    await user.click(screen.getByRole("button", { name: "Создать приглашение" }));

    expect(await screen.findByText(/bri_mock_/)).toBeInTheDocument();
  });
});
