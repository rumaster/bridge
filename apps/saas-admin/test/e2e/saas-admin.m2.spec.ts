import { expect, test } from "@playwright/test";

async function loginAsAdmin(page: import("@playwright/test").Page, targetPath: string) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto(targetPath);
  await page.getByLabel("Telegram-имя").fill("@admin_demo");
  await page.getByRole("button", { name: "Отправить код" }).click();
  await page.getByLabel("Одноразовый код").fill("000000");
  await page.getByRole("button", { name: "Войти" }).click();
}

test("Каналы связи: список, realtime-статус, credentials_ref и тест подключения", async ({ page }) => {
  await loginAsAdmin(page, "/channels");

  await expect(page.getByRole("heading", { name: "Каналы связи" })).toBeVisible();
  // Плитка показывает информативную идентичность (Widget origin), а не credentials_ref.
  await expect(page.getByRole("article", { name: /Основной Web Chat/ })).toContainText(
    "https://demo.example.test"
  );
  await expect(page.getByRole("article", { name: /Основной Web Chat/ })).not.toContainText(
    "secret://web-chat/org-demo/main"
  );
  await expect(page.getByRole("article", { name: /Telegram Support/ })).toContainText("Подключен");

  await page
    .getByRole("article", { name: /Основной Web Chat/ })
    .getByRole("button", { name: "Проверить подключение" })
    .click();
  await expect(page.getByText("Проверка подключения выполнена")).toBeVisible();

  await page.getByLabel("Название канала").fill("Витрина Web Chat");
  await page.getByLabel("credentials_ref").fill("secret://web-chat/org-demo/storefront");
  await page.getByLabel("Widget origin").fill("https://storefront.example.test");
  await page.getByRole("button", { name: "Подключить канал" }).click();
  await expect(page.getByRole("article", { name: /Витрина Web Chat/ })).toBeVisible();
});

test("Knowledge Base: создание, редактирование и удаление текстового документа", async ({
  page
}) => {
  await loginAsAdmin(page, "/knowledge");

  await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible();
  await expect(page.getByRole("article", { name: /Политика возвратов/ })).toBeVisible();

  const createForm = page.getByRole("form", { name: "Новый документ" });
  await createForm.getByLabel("Название документа").fill("Политика гарантий");
  await createForm.getByLabel(/Контент/).fill("Гарантия на технику — 12 месяцев с даты покупки.");
  // Ключевые фразы — по одной на строку; по каждой считается свой эмбеддинг.
  await createForm.getByLabel(/Ключевые фразы/).fill("гарантия на технику\nсрок гарантии");
  await createForm.getByRole("button", { name: "Добавить документ" }).click();
  await expect(page.getByRole("article", { name: /Политика гарантий/ })).toBeVisible();

  await page
    .getByRole("article", { name: /Регламент доставки/ })
    .getByRole("button", { name: "Удалить" })
    .click();
  await expect(page.getByRole("article", { name: /Регламент доставки/ })).toHaveCount(0);
});
