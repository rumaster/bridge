import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { createMockSaasAdminApiClient } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

/**
 * AI-ассистент живёт в боковой панели оболочки (кнопка у правого края), а не на
 * отдельном экране: открываем панель и, где нужна сводка конфигурации,
 * раскрываем её широко.
 */
async function openAiPanel(user: UserEvent, { wide = false } = {}) {
  await user.click(await screen.findByRole("button", { name: "Открыть панель AI-ассистента" }));
  if (wide) {
    await user.click(screen.getByRole("button", { name: "Расширить панель" }));
  }

  return screen.getByRole("dialog", { name: "AI-ассистент" });
}

// toHaveTextContent нормализует пробелы полученного текста через \s (сюда попадает NBSP из
// toLocaleString("ru-RU")), поэтому и в ожидаемой строке заменяем неразрывные пробелы обычными.
function ruNumber(value: number): string {
  return value.toLocaleString("ru-RU").replace(/\s/g, " ");
}

describe("SaaS Administration M3 AI Onboarding (C4)", () => {
  it("формирует команду из запроса, применяет её после подтверждения и отражает конфигурацию", async () => {
    const api = createMockSaasAdminApiClient();
    const createCommand = vi.spyOn(api.onboarding, "createCommand");
    const applyCommand = vi.spyOn(api.onboarding, "applyCommand");
    const { user } = renderRoute("/", { api, realtime: createMockC7RealtimeClient([]) });

    await openAiPanel(user, { wide: true });

    // Исходная конфигурация: лимит 10 000.
    const configPanel = await screen.findByRole("complementary", { name: "Текущая конфигурация" });
    await waitFor(() => {
      expect(configPanel).toHaveTextContent(ruNumber(10000));
    });

    // Диалоговый помощник формирует структурированную команду (ТЗ §16.8).
    await user.type(
      screen.getByLabelText("Опишите изменение"),
      "Подними месячный лимит сообщений до 50000"
    );
    await user.click(screen.getByRole("button", { name: "Сформировать команду" }));

    await waitFor(() => {
      expect(createCommand).toHaveBeenCalledWith({
        prompt: "Подними месячный лимит сообщений до 50000"
      });
    });

    const commandCard = await screen.findByRole("region", { name: "Подготовленная команда" });
    expect(within(commandCard).getByText("Изменение конфигурации")).toBeInTheDocument();
    expect(within(commandCard).getByText("AI")).toBeInTheDocument();
    expect(within(commandCard).getByText(/"monthlyMessageLimit": 50000/)).toBeInTheDocument();

    // Изменения применяются только после подтверждения администратором; проверяет Backend.
    await user.click(within(commandCard).getByRole("button", { name: "Подтвердить и применить" }));

    await waitFor(() => {
      expect(applyCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ action: "configuration.upsert" })
        })
      );
    });

    const resultCard = await screen.findByRole("region", { name: "Результат применения" });
    expect(within(resultCard).getByText("Изменения применены Backend.")).toBeInTheDocument();

    // Панель отражает обновлённую конфигурацию: лимит стал 50 000.
    await waitFor(() => {
      expect(configPanel).toHaveTextContent(ruNumber(50000));
    });
  });

  it("показывает заглушку, когда конфигурация загружена без месячного лимита", async () => {
    const api = createMockSaasAdminApiClient();
    vi.spyOn(api.org, "getConfiguration").mockResolvedValue({
      organizationId: "org-demo",
      aiAssistantEnabled: null,
      workflowAutomationEnabled: undefined,
      defaultLanguage: null,
      monthlyMessageLimit: undefined,
      notificationEmail: "admin@example.test",
      retentionDays: 90,
      updatedAt: "2026-07-03T09:12:00.000Z"
    } as unknown as Awaited<ReturnType<typeof api.org.getConfiguration>>);

    const { user } = renderRoute("/", { api, realtime: createMockC7RealtimeClient([]) });

    await openAiPanel(user, { wide: true });

    const configPanel = await screen.findByRole("complementary", { name: "Текущая конфигурация" });
    const monthlyLimit = within(configPanel).getByText("Месячный лимит сообщений").closest("div");

    expect(monthlyLimit).not.toBeNull();
    expect(within(monthlyLimit as HTMLElement).getByText("—")).toBeInTheDocument();
  });

  it("не применяет изменения, если администратор отклоняет команду", async () => {
    const api = createMockSaasAdminApiClient();
    const applyCommand = vi.spyOn(api.onboarding, "applyCommand");
    const { user } = renderRoute("/", { api, realtime: createMockC7RealtimeClient([]) });

    await openAiPanel(user);

    await user.type(screen.getByLabelText("Опишите изменение"), "Отключи автоматизацию Workflow");
    await user.click(screen.getByRole("button", { name: "Сформировать команду" }));

    const commandCard = await screen.findByRole("region", { name: "Подготовленная команда" });
    await user.click(within(commandCard).getByRole("button", { name: "Отклонить" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Подготовленная команда" })
      ).not.toBeInTheDocument();
    });
    expect(applyCommand).not.toHaveBeenCalled();
    expect(
      screen.getByText("Команда отклонена администратором. Изменения не применялись.")
    ).toBeInTheDocument();
  });

  it("сообщает, что команда требует подтверждения перед применением", async () => {
    const api = createMockSaasAdminApiClient();
    const { user } = renderRoute("/", { api, realtime: createMockC7RealtimeClient([]) });

    await openAiPanel(user);

    await user.type(screen.getByLabelText("Опишите изменение"), "Включи AI-ассистента");
    await user.click(screen.getByRole("button", { name: "Сформировать команду" }));

    const commandCard = await screen.findByRole("region", { name: "Подготовленная команда" });
    expect(
      within(commandCard).getByText(/Режим применения: проверка на стороне Backend/)
    ).toBeInTheDocument();
  });
});
