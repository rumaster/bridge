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

test("Admin правит Workflow: безопасная палитра, новая версия и переключение состояния", async ({
  page
}) => {
  await loginAsAdmin(page, "/workflow");

  await expect(page.getByRole("heading", { name: "Workflow", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Открыть Workflow Автоответчик обращений" })
  ).toBeVisible();

  // Палитра ограничена безопасным набором узлов (ТЗ §13.13).
  await expect(page.getByRole("button", { name: /^Добавить узел:/ })).toHaveCount(6);

  // Узел вызова Backend API помечен как изменяющий данные (ТЗ §13.5).
  await page.getByRole("button", { name: "Узел Создать тикет" }).click();
  await expect(
    page.getByRole("region", { name: "Редактор схемы Workflow" }).getByText("Изменяет данные")
  ).toBeVisible();

  // Добавляем узел, переименовываем и сохраняем как новую версию (ТЗ §13.10).
  await page.getByRole("button", { name: "Добавить узел: Ветвление" }).click();
  const labelInput = page.getByLabel("Метка узла");
  await labelInput.fill("Проверка бюджета");
  await page.getByRole("button", { name: "Сохранить как новую версию" }).click();

  await expect(
    page.getByText("Сохранена версия v3. Выполняющиеся инстансы не затронуты.")
  ).toBeVisible();

  // Включение/отключение Workflow (ТЗ §16.7).
  await page.getByRole("button", { name: "Отключить" }).click();
  await expect(page.getByText("Workflow отключен")).toBeVisible();

  // Диагностика инстанса из истории исполнения.
  await page
    .getByRole("region", { name: "История исполнения Workflow" })
    .getByRole("button", { name: "Диагностика инстанса wfi-support-1001" })
    .click();
  await expect(page.getByText("Backend API создал тикет T-1001.")).toBeVisible();
});

test("AI Onboarding применяет конфиг: команда, подтверждение и обновление UI", async ({ page }) => {
  await loginAsAdmin(page, "/onboarding");

  await expect(page.getByRole("heading", { name: "AI Onboarding", level: 1 })).toBeVisible();

  const configPanel = page.getByRole("complementary", { name: "Текущая конфигурация" });
  await expect(configPanel).toContainText(/10[  \s]?000/);

  // Диалоговый помощник формирует структурированную команду (ТЗ §16.8).
  await page
    .getByLabel("Опишите изменение")
    .fill("Подними месячный лимит сообщений до 50000");
  await page.getByRole("button", { name: "Сформировать команду" }).click();

  const commandCard = page.getByRole("region", { name: "Подготовленная команда" });
  await expect(commandCard).toBeVisible();
  await expect(commandCard).toContainText("Изменение конфигурации");
  await expect(commandCard).toContainText('"monthlyMessageLimit": 50000');

  // Backend применяет изменения только после подтверждения администратором.
  await commandCard.getByRole("button", { name: "Подтвердить и применить" }).click();

  await expect(
    page.getByRole("region", { name: "Результат применения" })
  ).toContainText("Изменения применены Backend.");

  // UI отражает обновлённую конфигурацию: лимит стал 50 000.
  await expect(configPanel).toContainText(/50[  \s]?000/);
});
