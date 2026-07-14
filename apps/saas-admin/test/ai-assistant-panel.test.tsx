import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockSaasAdminServices } from "../src/api/mocks/client";
import { createMockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides = createMockSaasAdminServices()) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

const TAB = "Открыть панель AI-ассистента";
const PANEL = { name: "AI-ассистент" };

/**
 * AI-ассистент вызывается кнопкой у правого края оболочки и раскрывается в две
 * ступени: чат и чат со сводкой конфигурации (ТЗ §16.8).
 */
describe("Боковая панель AI-ассистента", () => {
  it("свёрнута по умолчанию: виден только язычок у правого края", async () => {
    renderRoute("/");

    expect(await screen.findByRole("button", { name: TAB })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", PANEL)).not.toBeInTheDocument();
  });

  it("из меню убран пункт AI Onboarding — панель заменяет отдельный экран", async () => {
    renderRoute("/");
    await screen.findByRole("button", { name: TAB });

    const nav = screen.getByRole("navigation", { name: "Администрирование организации" });
    expect(nav).not.toHaveTextContent("AI Onboarding");
  });

  it("открывается язычком в узком режиме — чат без сводки конфигурации", async () => {
    const { user } = renderRoute("/");

    await user.click(await screen.findByRole("button", { name: TAB }));

    const panel = screen.getByRole("dialog", PANEL);
    expect(panel).toHaveClass("ai-panel--half");
    expect(screen.getByLabelText("Опишите изменение")).toBeInTheDocument();
    // Сводка конфигурации — принадлежность широкого режима.
    expect(screen.queryByRole("complementary", { name: "Текущая конфигурация" })).not.toBeInTheDocument();
    // Язычок уступает место панели.
    expect(screen.queryByRole("button", { name: TAB })).not.toBeInTheDocument();
  });

  it("раскрывается широко и возвращается в узкий режим", async () => {
    const { user } = renderRoute("/");

    await user.click(await screen.findByRole("button", { name: TAB }));
    await user.click(screen.getByRole("button", { name: "Расширить панель" }));

    expect(screen.getByRole("dialog", PANEL)).toHaveClass("ai-panel--wide");
    expect(
      await screen.findByRole("complementary", { name: "Текущая конфигурация" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Сузить панель" }));

    expect(screen.getByRole("dialog", PANEL)).toHaveClass("ai-panel--half");
    expect(screen.queryByRole("complementary", { name: "Текущая конфигурация" })).not.toBeInTheDocument();
  });

  it("закрывается кнопкой и по Escape, возвращая язычок", async () => {
    const { user } = renderRoute("/");

    await user.click(await screen.findByRole("button", { name: TAB }));
    await user.click(screen.getByRole("button", { name: "Закрыть панель AI-ассистента" }));

    expect(screen.queryByRole("dialog", PANEL)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAB })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: TAB }));
    expect(screen.getByRole("dialog", PANEL)).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", PANEL)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: TAB })).toBeInTheDocument();
  });

  it("недоступна роли без прав администратора: ассистент правит конфигурацию организации", async () => {
    renderRoute(
      "/workflow",
      createMockSaasAdminServices({ session: createMockSession(["platform_operator"]) })
    );
    await screen.findByRole("heading", { level: 1, name: "Workflow" });

    expect(screen.queryByRole("button", { name: TAB })).not.toBeInTheDocument();
  });
});
