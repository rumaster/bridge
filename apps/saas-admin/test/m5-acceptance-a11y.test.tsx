import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createMockSaasAdminServices } from "../src/api/mocks/client";
import { createSaasAdminRouter } from "../src/routing/router";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

/**
 * M5 — приёмка, доступность и адаптивность (ТЗ §21.8, §29).
 *
 * Общий прогон ключевых админ-экранов (мастер §8.2) в jsdom проверяет:
 * семантические лендмарки, единственный H1 на экран, ссылку «пропустить
 * навигацию» и информационную архитектуру экранов (визуальная регрессия
 * структуры). Пиксельная адаптивность Desktop/Tablet и визуальная регрессия
 * рендера покрыты Playwright-сценарием `test/e2e/saas-admin.m5.spec.ts`.
 */

interface AdminScreen {
  path: string;
  heading: string;
}

const KEY_SCREENS: AdminScreen[] = [
  { path: "/overview", heading: "Административная панель" },
  { path: "/organization", heading: "Организация и конфигурация" },
  { path: "/users", heading: "Пользователи и роли" },
  { path: "/channels", heading: "Каналы связи" },
  { path: "/knowledge", heading: "Knowledge Base" },
  { path: "/workflow", heading: "Workflow" },
  { path: "/onboarding", heading: "AI Onboarding" },
  { path: "/broadcast", heading: "Broadcast" },
  { path: "/notifications", heading: "Notification" }
];

const SCREEN_READY_HEADINGS: Record<string, string[]> = {
  "/broadcast": ["Приветственная серия", "Июльская акция"],
  "/channels": ["Telegram Support"],
  "/knowledge": ["FAQ возвратов", "Регламент доставки", "Прайс-лист"],
  "/notifications": [
    "Кампания «Приветственная серия» завершена",
    "Канал Telegram Support недоступен",
    "Использовано 80% месячного лимита сообщений"
  ],
  "/onboarding": ["Текущая конфигурация"],
  "/workflow": ["Автоответчик обращений", "История исполнения"]
};

function renderRoute(path: string, services: SaasAdminServiceOverrides = createMockSaasAdminServices()) {
  const router = createSaasAdminRouter({ initialEntries: [path], services });
  return render(<RouterProvider router={router} />);
}

describe("SaaS Administration M5 acceptance and accessibility", () => {
  it.each(KEY_SCREENS)(
    "экран $path приёмки соблюдает лендмарки, единственный H1 и skip-link",
    async ({ heading, path }) => {
      renderRoute(path);

      const pageHeading = await screen.findByRole("heading", { level: 1, name: heading });
      expect(pageHeading).toBeInTheDocument();

      // Единственный H1 на экран — иерархия заголовков корректна для скринридеров.
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

      // Основные лендмарки присутствуют и имеют доступные имена.
      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(
        screen.getByRole("navigation", { name: "Администрирование организации" })
      ).toBeInTheDocument();

      // Ссылка «пропустить навигацию» ведёт к области содержимого.
      const skipLink = screen.getByRole("link", { name: "Перейти к содержимому" });
      expect(skipLink).toHaveAttribute("href", "#main-content");

      // Каждая интерактивная кнопка имеет доступное имя (нет «немых» кнопок).
      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAccessibleName();
      }
    }
  );

  it("основная навигация озвучивает все административные разделы", async () => {
    renderRoute("/overview");
    await screen.findByRole("heading", { level: 1, name: "Административная панель" });

    const nav = screen.getByRole("navigation", { name: "Администрирование организации" });
    const linkNames = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());

    expect(linkNames).toEqual([
      "Обзор",
      "Организация",
      "Пользователи",
      "Каналы",
      "Knowledge Base",
      "Workflow",
      "AI Onboarding",
      "Broadcast",
      "Уведомления"
    ]);
  });

  it("фиксирует информационную архитектуру ключевых экранов (визуальная регрессия структуры)", async () => {
    const architecture: Record<string, { level: number; name: string }[]> = {};

    for (const { heading, path } of KEY_SCREENS) {
      const view = renderRoute(path);
      await screen.findByRole("heading", { level: 1, name: heading });
      for (const readyHeading of SCREEN_READY_HEADINGS[path] ?? []) {
        await screen.findByRole("heading", { name: readyHeading });
      }

      architecture[path] = screen
        .getAllByRole("heading")
        .map((node) => ({
          level: Number(node.tagName.slice(1)),
          name: node.textContent?.trim() ?? ""
        }));

      view.unmount();
    }

    expect(architecture).toMatchSnapshot();
  });

  it("сохраняет адаптивные брейкпоинты Desktop/Tablet (ТЗ §21.8)", () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), "src/presentation/styles.css"),
      "utf8"
    );

    // Планшетный брейкпоинт сворачивает сайдбар в верхнюю навигацию.
    expect(stylesheet).toMatch(/@media \(max-width: 820px\)/);
    // Узкий брейкпоинт для компактных планшетов/телефонов.
    expect(stylesheet).toMatch(/@media \(max-width: 620px\)/);
    // Уважение системной настройки об уменьшении анимаций.
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
