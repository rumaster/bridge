import { expect, test } from "@playwright/test";

/**
 * Хостируемая страница организации `/chat/<organizationId>` (W5, WG-1/WG-2,
 * docs/plan/web-chat-channel-production.md): организация берётся из URL, виджет
 * монтируется и работает (тот же код, что и встраиваемый компонент). Без
 * организации — подсказка, а не «дефолтная» организация.
 */
const ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";

test("страница организации монтирует виджет и проводит сообщение", async ({ page }) => {
  await page.goto(`/chat/${ORGANIZATION_ID}`);

  const input = page.getByLabel("Сообщение");
  await expect(input).toBeVisible();

  await input.fill("Привет со страницы организации");
  await page.getByRole("button", { name: /Отправить/ }).click();

  await expect(page.getByText("Привет со страницы организации")).toBeVisible();
  await expect(
    page.getByText("Здравствуйте! Менеджер получил сообщение."),
  ).toBeVisible();
});

test("без организации в URL — подсказка вместо виджета", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText(/Организация не указана/)).toBeVisible();
  await expect(page.getByLabel("Сообщение")).toHaveCount(0);
});
