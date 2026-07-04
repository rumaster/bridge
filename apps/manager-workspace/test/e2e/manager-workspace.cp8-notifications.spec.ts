import { expect, test } from "@playwright/test";

// CP-8 «Notification в Web» — web-часть сценария «Notification в Web + Telegram».
// Проверяем индикатор непрочитанных, ленту C10 с категориями, realtime C7
// `notification.created` и отметку прочтения C10 `POST /notifications/{id}:read`.
test("Notification в Web: индикатор, лента C10, realtime C7 и отметка прочтения", async ({ page }) => {
  await page.goto("/notifications");

  await expect(page.getByRole("heading", { name: "Уведомления" })).toBeVisible();

  // Лента C10 с категориями info/warning.
  await expect(page.getByText("Новый диалог в очереди")).toBeVisible();
  await expect(page.getByText("Информация")).toBeVisible();
  await expect(page.getByText("Диалог ожидает дольше SLA")).toBeVisible();

  // Realtime C7 notification.created доставляет критическое уведомление (initial: notif-1 new).
  await expect(page.getByText("Критический сбой канала Telegram")).toBeVisible();
  await expect(page.getByText("Критично")).toBeVisible();

  // Индикатор непрочитанных в навигации: notif-1 + realtime critical → 2.
  await expect(page.getByLabel("Непрочитанных уведомлений: 2")).toBeVisible();

  // Отметка прочтения (C10 :read) уведомления из ленты синхронизирует счётчик 2 → 1.
  const infoRow = page.locator("article.notification-row", { hasText: "Новый диалог в очереди" });
  await infoRow.getByRole("button", { name: "Отметить прочитанным" }).click();
  await expect(page.getByLabel("Непрочитанных уведомлений: 1")).toBeVisible();
});
