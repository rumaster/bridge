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

test("Broadcast: администратор создаёт черновик и запускает доставку кампании (CP-6)", async ({
  page
}) => {
  await loginAsAdmin(page, "/broadcast");

  await expect(page.getByRole("heading", { name: "Broadcast", level: 1 })).toBeVisible();

  // Существующие кампании и статистика доставки видны из фасада C8.
  const welcomeCard = page.getByRole("article", { name: /Приветственная серия/ });
  await expect(welcomeCard).toBeVisible();
  await expect(welcomeCard.getByText("Завершена")).toBeVisible();
  await expect(welcomeCard.getByText("98%")).toBeVisible();

  // UI формирует только описание кампании; доставку выполняет SVC-BCAST (ТЗ §21.5).
  await page.getByLabel("Название кампании").fill("E2E рассылка");
  await page.getByLabel("Текст сообщения").fill("Здравствуйте!");
  await page.getByRole("button", { name: "Создать черновик" }).click();

  const draftCard = page.getByRole("article", { name: /E2E рассылка/ });
  await expect(draftCard).toBeVisible();
  await expect(draftCard.getByText("Черновик")).toBeVisible();

  // Немедленный запуск переводит кампанию в статус «Выполняется».
  await draftCard.getByRole("button", { name: "Запустить" }).click();
  await expect(page.getByText(/Кампания .*E2E рассылка.* запущена/)).toBeVisible();
  await expect(draftCard.getByText("Выполняется")).toBeVisible();
});

test("Notification: администратор читает уведомление и включает Web + Telegram (CP-8)", async ({
  page
}) => {
  await loginAsAdmin(page, "/notifications");

  await expect(page.getByRole("heading", { name: "Notification", level: 1 })).toBeVisible();

  // Лента уведомлений отображается из фасада C10 (ТЗ §15.4).
  const errorCard = page.getByRole("article", { name: /Канал Telegram Support недоступен/ });
  await expect(errorCard).toBeVisible();

  // Отметка «прочитано» выполняется через C10.
  await errorCard.getByRole("button", { name: "Отметить прочитанным" }).click();
  await expect(errorCard.getByText("Прочитано")).toBeVisible();

  // Каналы доставки: Web и Telegram по категориям (§15.4).
  const settingsTable = page.getByRole("table", { name: "Настройки каналов доставки" });
  await expect(settingsTable.getByRole("columnheader", { name: "Веб" })).toBeVisible();
  await expect(settingsTable.getByRole("columnheader", { name: "Telegram" })).toBeVisible();

  const saveButton = page.getByRole("button", { name: "Сохранить настройки" });
  await expect(saveButton).toBeDisabled();

  // Включаем Telegram для категории «Информация» и сохраняем.
  await page.getByLabel("Информация · Telegram").check();
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  await expect(page.getByText("Настройки уведомлений сохранены")).toBeVisible();
});
