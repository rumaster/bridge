import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockManagerWorkspaceApiClient } from "../src/api/mocks/client";
import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { mockC7Events } from "../src/api/mocks/fixtures";
import type { ManagerWorkspaceServices } from "../src/state/workspace";
import { createManagerWorkspaceRouter } from "../src/routing/router";

function renderNotifications(services?: ManagerWorkspaceServices) {
  const router = createManagerWorkspaceRouter({
    initialEntries: ["/notifications"],
    services:
      services ?? {
        api: createMockManagerWorkspaceApiClient(),
        // Только события без realtime-уведомления — детерминируем счётчик в базовых кейсах.
        realtime: createMockC7RealtimeClient(
          mockC7Events.filter((event) => event.event !== "notification.created")
        )
      }
  });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("Manager Workspace CP-8 центр уведомлений", () => {
  it("рендерит ленту C10 с категориями и статусами", async () => {
    renderNotifications();

    expect(await screen.findByRole("heading", { name: "Уведомления" })).toBeInTheDocument();
    expect(await screen.findByText("Новый диалог в очереди")).toBeInTheDocument();
    expect(screen.getByText("Информация")).toBeInTheDocument();

    expect(await screen.findByText("Диалог ожидает дольше SLA")).toBeInTheDocument();
    expect(screen.getByText("Предупреждение")).toBeInTheDocument();
  });

  it("показывает индикатор непрочитанных и синхронизирует его с отметкой прочтения (C10 :read)", async () => {
    const { user } = renderNotifications();

    const indicator = await screen.findByLabelText("Непрочитанных уведомлений: 1");
    expect(indicator).toHaveTextContent("1");

    await user.click(await screen.findByRole("button", { name: "Отметить прочитанным" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Отметить прочитанным" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/Непрочитанных уведомлений/)).not.toBeInTheDocument();
    });
  });

  it("увеличивает счётчик по realtime-событию C7 notification.created", async () => {
    const services: ManagerWorkspaceServices = {
      api: createMockManagerWorkspaceApiClient(),
      realtime: createMockC7RealtimeClient(mockC7Events)
    };
    renderNotifications(services);

    expect(await screen.findByLabelText("Непрочитанных уведомлений: 1")).toBeInTheDocument();

    // C7 доставляет новое критическое уведомление → счётчик 1 → 2.
    expect(await screen.findByLabelText("Непрочитанных уведомлений: 2")).toBeInTheDocument();
    expect(await screen.findByText("Критический сбой канала Telegram")).toBeInTheDocument();
    expect(screen.getByText("Критично")).toBeInTheDocument();
  });

  it("возвращает статус new при ошибке C10 :read и показывает текст ошибки", async () => {
    const api = createMockManagerWorkspaceApiClient();
    api.notifications.markRead = async () => {
      throw new Error("C10 недоступен");
    };
    const services: ManagerWorkspaceServices = {
      api,
      realtime: createMockC7RealtimeClient(
        mockC7Events.filter((event) => event.event !== "notification.created")
      )
    };
    const { user } = renderNotifications(services);

    await user.click(await screen.findByRole("button", { name: "Отметить прочитанным" }));

    expect(await screen.findByText("C10 недоступен")).toBeInTheDocument();
    // Кнопка возвращается, счётчик остаётся прежним.
    expect(await screen.findByRole("button", { name: "Отметить прочитанным" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Непрочитанных уведомлений: 1")).toBeInTheDocument();
  });

  it("отображает индикатор непрочитанных в навигации рабочего места", async () => {
    renderNotifications();

    const nav = await screen.findByRole("navigation", { name: "Рабочее место менеджера" });
    const badge = await within(nav).findByLabelText("Непрочитанных уведомлений: 1");
    expect(badge).toHaveTextContent("1");
  });
});
