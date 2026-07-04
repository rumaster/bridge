import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function loginAsAdmin(page: Page, targetPath: string) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto(targetPath);
  await page.getByLabel("Telegram-имя").fill("@admin_demo");
  await page.getByRole("button", { name: "Отправить код" }).click();
  await page.getByLabel("Одноразовый код").fill("000000");
  await page.getByRole("button", { name: "Войти" }).click();
}

// Ключевые экраны приёмки (мастер §8.2): раздел → ожидаемый заголовок H1.
const KEY_SCREENS = [
  { section: "Обзор", heading: "Административная панель" },
  { section: "Организация", heading: "Организация и конфигурация" },
  { section: "Каналы", heading: "Каналы связи" },
  { section: "Knowledge Base", heading: "Knowledge Base" },
  { section: "Workflow", heading: "Workflow" },
  { section: "AI Onboarding", heading: "AI Onboarding" },
  { section: "Broadcast", heading: "Broadcast" },
  { section: "Уведомления", heading: "Notification" }
] as const;

test("Общий прогон приёмки: единый вход и обход всех админ-разделов (CP-9)", async ({ page }) => {
  await loginAsAdmin(page, "/overview");

  await expect(page.getByRole("heading", { level: 1, name: "Административная панель" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Администрирование организации" });

  // Один вход — обход каналов/KB/Workflow/Onboarding/Broadcast/уведомлений в общем прогоне.
  for (const { heading, section } of KEY_SCREENS) {
    await nav.getByRole("link", { name: section }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    // На каждом экране ровно один H1 — иерархия заголовков корректна.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  }
});

test("Доступность: skip-link ведёт к содержимому и лендмарки на месте", async ({ page }) => {
  await loginAsAdmin(page, "/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Административная панель" })).toBeVisible();

  // Клавиатурная навигация: первый Tab фокусирует ссылку «пропустить навигацию».
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Перейти к содержимому" });
  await expect(skipLink).toBeFocused();

  await skipLink.click();
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("#main-content")).toBeVisible();

  // Основные лендмарки доступны скринридеру.
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Администрирование организации" })).toBeVisible();
});

const VIEWPORTS = [
  { name: "Desktop", width: 1280, height: 800 },
  { name: "Tablet (портрет)", width: 768, height: 1024 },
  { name: "Tablet (ландшафт)", width: 1024, height: 768 }
] as const;

for (const viewport of VIEWPORTS) {
  test(`Адаптивность ${viewport.name}: навигация и содержимое без горизонтального скролла (ТЗ §21.8)`, async ({
    page
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await loginAsAdmin(page, "/channels");

    await expect(page.getByRole("heading", { level: 1, name: "Каналы связи" })).toBeVisible();

    // Навигация и все разделы остаются доступными на планшете/десктопе.
    const nav = page.getByRole("navigation", { name: "Администрирование организации" });
    await expect(nav.getByRole("link", { name: "Broadcast" })).toBeVisible();

    // Нет горизонтального переполнения макета на выбранной ширине.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });
}
