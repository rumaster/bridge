import { BridgeApiError } from "@bridge/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockSaasAdminApiClient, createMockSaasAdminServices } from "../src/api/mocks/client";
import { mockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { AdminSession, ProblemDetails } from "../src/api/client/types";

function renderRoute(path: string, services = createMockSaasAdminServices()) {
  const router = createSaasAdminRouter({
    initialEntries: [path],
    services
  });

  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration M1 organization configuration", () => {
  it("saves organization metadata and configuration through C3.org", async () => {
    const api = createMockSaasAdminApiClient();
    const updateOrganization = vi.spyOn(api.org, "updateOrganization");
    const updateConfiguration = vi.spyOn(api.org, "updateConfiguration");
    const { user } = renderRoute("/organization", { api });

    const name = await screen.findByLabelText("Название организации");
    await user.clear(name);
    await user.type(name, "Bridge Operations");

    const email = screen.getByLabelText("Email уведомлений");
    await user.clear(email);
    await user.type(email, "ops@example.test");

    const monthlyLimit = screen.getByLabelText("Месячный лимит сообщений");
    await user.clear(monthlyLimit);
    await user.type(monthlyLimit, "25000");

    await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    expect(await screen.findByText("Изменения сохранены")).toBeInTheDocument();
    expect(updateOrganization).toHaveBeenCalledWith(
      mockSession.organization.id,
      expect.objectContaining({
        name: "Bridge Operations"
      })
    );
    expect(updateConfiguration).toHaveBeenCalledWith(
      mockSession.organization.id,
      expect.objectContaining({
        monthlyMessageLimit: 25000,
        notificationEmail: "ops@example.test"
      })
    );
  });

  it("renders Backend validation errors next to configuration fields", async () => {
    const api = createMockSaasAdminApiClient();
    vi.spyOn(api.org, "updateConfiguration").mockRejectedValue(
      new BridgeApiError<ProblemDetails>("Validation failed", {
        status: 400,
        url: "/api/v1/organizations/org-demo/configuration",
        body: {
          type: "https://bridge.local/problems/validation-error",
          title: "Validation failed",
          status: 400,
          detail: "Request payload does not match C3.org configuration DTO.",
          errors: [
            {
              field: "notificationEmail",
              message: "Email уведомлений должен быть в корпоративном домене."
            }
          ]
        }
      })
    );

    const { user } = renderRoute("/organization", { api });

    const email = await screen.findByLabelText("Email уведомлений");
    await user.clear(email);
    await user.type(email, "ops@example.test");
    await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    expect(
      await screen.findByText("Email уведомлений должен быть в корпоративном домене.")
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Request payload does not match C3.org");
  });

  it("keeps administrative navigation as a role-based UX hint only", async () => {
    const managerSession: AdminSession = {
      ...mockSession,
      roles: ["manager"]
    };

    const { user } = renderRoute("/overview", {
      api: createMockSaasAdminApiClient({ session: managerSession })
    });

    expect(await screen.findByRole("heading", { name: "Административная панель" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Организация/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Выйти" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Вход администратора" })).toBeInTheDocument();
    });
  });
});
