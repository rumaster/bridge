import { expect, test } from "@playwright/test";

test("Работа менеджера: очередь, история, ответ", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Вход менеджера" })).toBeVisible();
  await page.getByLabel("Telegram username").fill("manager_demo");
  await page.getByRole("button", { name: "Запросить код" }).click();
  await expect(page.getByText("Код отправлен в Telegram")).toBeVisible();
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText(/Активная сессия: Демо Менеджер/)).toBeVisible();

  await page.getByRole("link", { name: "Перейти в рабочее место" }).click();
  await expect(page.getByRole("heading", { name: "Очередь диалогов" })).toBeVisible();
  await page.getByLabel("Поиск клиента").fill("Анна");
  await expect(page.getByText("Анна Петрова")).toBeVisible();
  await page.getByRole("link", { name: "Открыть" }).first().click();

  await expect(page.getByRole("heading", { name: "Диалог" })).toBeVisible();
  await expect(page.getByText("Хочу уточнить статус заказа")).toBeVisible();
  await expect(page.getByText("order-status.png")).toBeVisible();
  await expect(page.getByText("web-chat:anna")).toBeVisible();

  await page.getByLabel("Ответ менеджера").fill("Ответ отправлен из e2e-сценария");
  await page.getByRole("button", { name: "Отправить" }).click();

  await expect(page.getByText("Ответ отправлен из e2e-сценария")).toBeVisible();
});
