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

test("Knowledge Base: загрузка, переиндексация и удаление документа", async ({ page }) => {
  await loginAsAdmin(page, "/knowledge");

  await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible();
  await expect(page.getByRole("article", { name: /FAQ возвратов/ })).toBeVisible();

  await page.getByLabel("Название документа").fill("Политика гарантий");
  await page.getByLabel("Источник", { exact: true }).fill("manual://warranty");
  await page.getByLabel("Файл документа").setInputFiles({
    name: "warranty.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Гарантийные правила")
  });
  await page.getByRole("button", { name: "Загрузить документ" }).click();
  await expect(page.getByRole("article", { name: /Политика гарантий/ })).toBeVisible();

  await page
    .getByRole("article", { name: /FAQ возвратов/ })
    .getByRole("button", { name: "Переиндексировать" })
    .click();
  await expect(page.getByRole("article", { name: /FAQ возвратов/ })).toContainText("Индексация");

  await page
    .getByRole("article", { name: /Прайс-лист/ })
    .getByRole("button", { name: "Удалить документ" })
    .click();
  await expect(page.getByRole("article", { name: /Прайс-лист/ })).toHaveCount(0);
});
