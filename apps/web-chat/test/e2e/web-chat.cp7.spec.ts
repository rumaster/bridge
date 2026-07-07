import { expect, test } from "@playwright/test";

// e2e CP-7 «Потеря соединения» (ТЗ §5.5, §7.9, §7.10): клиент РФ подключён через
// Edge Cluster; при разрыве реплика буферизуется и не теряется, а после
// восстановления виджет сам переотправляет её без дублей и с ответом менеджера.
test("CP-7 «Потеря соединения»: буфер и автопереотправка через Edge", async ({
  page,
}) => {
  await page.goto("/");

  const input = page.getByLabel("Сообщение");
  await expect(input).toBeVisible();

  // Трафик виджета прозрачно идёт через Edge Cluster (§18.7).
  await expect(page.getByText(/через Edge/)).toBeVisible();
  // Дожидаемся установленного соединения перед эмуляцией разрыва.
  await expect(page.getByText(/онлайн/)).toBeVisible();

  // Разрыв канала до Edge: REST-отправка падает, WS-подключение обрывается.
  await page.evaluate(() => window.__bridgeWebChatE2E?.simulateEdgeOutage());

  await input.fill("Реплика во время разрыва");
  await page.getByRole("button", { name: /Отправить/ }).click();

  // Реплика не потеряна: остаётся в ленте и помечена ошибкой отправки.
  await expect(page.getByText("Реплика во время разрыва")).toBeVisible();
  await expect(page.getByText("ошибка")).toBeVisible();

  // Канал восстановлен — виджет переподключается и автоматически
  // переотправляет буфер исходящих (CP-7).
  await page.evaluate(() => window.__bridgeWebChatE2E?.restoreEdge());

  // Дедупликация по idempotency_key: ровно одна реплика посетителя, доставлена.
  await expect(page.getByText("доставлено")).toBeVisible();
  await expect(page.getByText("ошибка")).toHaveCount(0);
  await expect(page.getByText("Реплика во время разрыва")).toHaveCount(1);

  // Ответ менеджера подтянут докруткой ленты после переотправки (§7.10).
  await expect(
    page.getByText("Здравствуйте! Менеджер получил сообщение."),
  ).toBeVisible();
});
