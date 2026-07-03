import { expect, test } from "@playwright/test";

test("Авторизация: Telegram-имя, одноразовый код и защищённый раздел", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/organization");

  await expect(page.getByRole("heading", { name: "Вход администратора" })).toBeVisible();
  await page.getByLabel("Telegram-имя").fill("@admin_demo");
  await page.getByRole("button", { name: "Отправить код" }).click();

  await expect(page.getByText(/Код отправлен в Telegram/)).toBeVisible();
  await page.getByLabel("Одноразовый код").fill("000000");
  await page.getByRole("button", { name: "Войти" }).click();

  await expect(page.getByRole("heading", { name: "Организация и конфигурация" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить изменения" })).toBeVisible();
});
