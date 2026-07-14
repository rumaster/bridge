import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { mockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { C7Event } from "../src/api/client/types";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration M4 Broadcast (C8, CP-6)", () => {
  it("отображает кампании, статистику доставки и статусы из фикстур C8", async () => {
    const api = createMockSaasAdminApiClient();
    const { user: _user } = renderRoute("/broadcast", {
      api,
      realtime: createMockC7RealtimeClient([])
    });

    const doneCard = await screen.findByRole("article", { name: /Приветственная серия/ });
    expect(within(doneCard).getByText("Завершена")).toBeInTheDocument();
    // Доставляемость 1180/1200 = 98% (детерминированно).
    expect(within(doneCard).getByText("98%")).toBeInTheDocument();

    const scheduledCard = screen.getByRole("article", { name: /Июльская акция/ });
    expect(within(scheduledCard).getByText("Запланирована")).toBeInTheDocument();
    // UI не раскрывает логику доставки — только статистику фасада (ТЗ §21.5).
    expect(scheduledCard).toBeInTheDocument();
  });

  it("создаёт черновик кампании через фасад C8 и добавляет его в список", async () => {
    const api = createMockSaasAdminApiClient();
    const createBroadcast = vi.spyOn(api.broadcasts, "createBroadcast");
    const { user } = renderRoute("/broadcast", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Broadcast", level: 1 });

    await user.type(screen.getByLabelText("Название кампании"), "Осенняя рассылка");
    await user.type(screen.getByLabelText("Текст сообщения"), "Здравствуйте, друзья!");
    await user.click(screen.getByRole("button", { name: "Создать черновик" }));

    expect(await screen.findByRole("article", { name: /Осенняя рассылка/ })).toBeInTheDocument();
    expect(await screen.findByText(/Черновик кампании .*Осенняя рассылка.* создан/)).toBeInTheDocument();
    expect(createBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Осенняя рассылка",
        template: expect.objectContaining({ type: "text", body: "Здравствуйте, друзья!" }),
        schedule: { mode: "manual" },
        rate_limit: expect.objectContaining({ messages_per_minute: 60, strategy: "fixed" })
      })
    );
  });

  it("валидирует черновик на стороне UI до вызова фасада C8", async () => {
    const api = createMockSaasAdminApiClient();
    const createBroadcast = vi.spyOn(api.broadcasts, "createBroadcast");
    const { user } = renderRoute("/broadcast", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Broadcast", level: 1 });
    await user.click(screen.getByRole("button", { name: "Создать черновик" }));

    expect(
      await screen.findByText("Название кампании должно содержать минимум 2 символа.")
    ).toBeInTheDocument();
    expect(screen.getByText("Текст сообщения обязателен.")).toBeInTheDocument();
    expect(createBroadcast).not.toHaveBeenCalled();
  });

  it("запускает кампанию через C8 и обновляет статистику и статус", async () => {
    const api = createMockSaasAdminApiClient();
    const startBroadcast = vi.spyOn(api.broadcasts, "startBroadcast");
    const { user } = renderRoute("/broadcast", { api, realtime: createMockC7RealtimeClient([]) });

    const scheduledCard = await screen.findByRole("article", { name: /Июльская акция/ });
    await user.click(within(scheduledCard).getByRole("button", { name: "Запустить" }));

    await waitFor(() => {
      expect(startBroadcast).toHaveBeenCalledWith(
        "broadcast-promo-july",
        expect.objectContaining({
          mode: "immediate"
        })
      );
    });
    expect(await screen.findByText(/Кампания .*Июльская акция.* запущена/)).toBeInTheDocument();
    expect(within(scheduledCard).getByText("Выполняется")).toBeInTheDocument();
  });

  it("применяет realtime broadcast.state_changed из C7 к статусу и статистике", async () => {
    const api = createMockSaasAdminApiClient();
    const event: C7Event = {
      type: "broadcast.state_changed",
      sequenceNumber: 1,
      payload: {
        broadcastId: "broadcast-promo-july",
        status: "done",
        stats: {
          prepared: 340,
          sent: 340,
          delivered: 330,
          failed: 10,
          updated_at: "2026-07-03T12:20:00.000Z"
        }
      }
    };

    renderRoute("/broadcast", { api, realtime: createMockC7RealtimeClient([event]) });

    const promoCard = await screen.findByRole("article", { name: /Июльская акция/ });
    await waitFor(() => {
      expect(within(promoCard).getByText("Завершена")).toBeInTheDocument();
    });
    // 330/340 ≈ 97%.
    expect(within(promoCard).getByText("97%")).toBeInTheDocument();
  });
});

describe("SaaS Administration M4 Notification (C10, CP-8)", () => {
  it("отображает ленту, счётчик непрочитанных и настройки каналов", async () => {
    const api = createMockSaasAdminApiClient();
    renderRoute("/notifications", { api, realtime: createMockC7RealtimeClient([]) });

    expect(
      await screen.findByRole("article", { name: /Кампания «Приветственная серия» завершена/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /Канал Telegram Support недоступен/ })).toBeInTheDocument();

    // Матрица настроек: категории × каналы (web/telegram/email/push).
    const settingsTable = screen.getByRole("table", { name: "Настройки каналов доставки" });
    expect(within(settingsTable).getByRole("columnheader", { name: "Telegram" })).toBeInTheDocument();
    expect(within(settingsTable).getByRole("columnheader", { name: "Push" })).toBeInTheDocument();
  });

  it("отмечает уведомление прочитанным через фасад C10", async () => {
    const api = createMockSaasAdminApiClient();
    const markRead = vi.spyOn(api.notifications, "markRead");
    const { user } = renderRoute("/notifications", { api, realtime: createMockC7RealtimeClient([]) });

    const card = await screen.findByRole("article", { name: /Канал Telegram Support недоступен/ });
    await user.click(within(card).getByRole("button", { name: "Отметить прочитанным" }));

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith("notif-channel-telegram-error");
    });
    expect(await within(card).findByText("Прочитано")).toBeInTheDocument();
  });

  it("сохраняет изменённые настройки каналов через C10 (web + telegram)", async () => {
    const api = createMockSaasAdminApiClient();
    const updateSettings = vi.spyOn(api.notifications, "updateSettings");
    const { user } = renderRoute("/notifications", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Notification", level: 1 });

    const saveButton = screen.getByRole("button", { name: "Сохранить настройки" });
    // До изменений кнопка неактивна (нет расхождений с сервером).
    expect(saveButton).toBeDisabled();

    // Включаем Telegram для категории «Информация» (по умолчанию выключен).
    await user.click(screen.getByLabelText("Информация · Telegram"));
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.arrayContaining([
            expect.objectContaining({ category: "info", channel: "telegram", enabled: true })
          ])
        })
      );
    });
    expect(await screen.findByText("Настройки уведомлений сохранены")).toBeInTheDocument();
  });

  it("добавляет новое уведомление из realtime notification.created (C7)", async () => {
    const api = createMockSaasAdminApiClient();
    const event: C7Event = {
      type: "notification.created",
      sequenceNumber: 1,
      payload: {
        notification: {
          contract: "C10.Notification",
          version: "1.0.0",
          id: "notif-realtime-1",
          organization_id: "org-demo",
          recipient_user_id: mockSession.user.id,
          category: "critical",
          title: "Превышен лимит сообщений",
          body: "Месячный лимит исчерпан.",
          payload: {},
          status: "new",
          channels: ["web", "telegram"],
          created_at: "2026-07-03T12:30:00.000Z",
          read_at: null
        }
      }
    };

    renderRoute("/notifications", { api, realtime: createMockC7RealtimeClient([event]) });

    expect(
      await screen.findByRole("article", { name: /Превышен лимит сообщений/ })
    ).toBeInTheDocument();
  });
});
