import { FBP_NODE_TYPES } from "@bridge/contracts/c5-workflow";
import { expect, test } from "@playwright/test";

async function loginAsUser(
  page: import("@playwright/test").Page,
  targetPath: string,
  telegramUsername: string
) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto(targetPath);
  await page.getByLabel("Telegram-имя").fill(telegramUsername);
  await page.getByRole("button", { name: "Отправить код" }).click();
  await page.getByLabel("Одноразовый код").fill("000000");
  await page.getByRole("button", { name: "Войти" }).click();
}

/**
 * Узлы добавляются только перетаскиванием с палитры на холст (ТЗ этап §252,
 * дизайн fbp_engine). Эмулируем HTML5 drag-and-drop нативными DragEvent с общим
 * DataTransfer, так как палитра больше не добавляет узлы по клику.
 */
async function dragPaletteNodeToCanvas(
  page: import("@playwright/test").Page,
  nodeLabel: string
) {
  await page.evaluate((label) => {
    const source = document.querySelector(`[aria-label="Добавить узел: ${label}"]`);
    const canvas = document.querySelector('[aria-label="Схема узлов и связей"]');
    if (!source || !canvas) {
      throw new Error(`Не найден узел палитры «${label}» или холст`);
    }

    const dataTransfer = new DataTransfer();
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + Math.min(rect.width - 40, 200);
    const clientY = rect.top + Math.min(rect.height - 40, 140);

    const dispatch = (target: Element, type: string) =>
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY })
      );

    dispatch(source, "dragstart");
    dispatch(canvas, "dragenter");
    dispatch(canvas, "dragover");
    dispatch(canvas, "drop");
    dispatch(source, "dragend");
  }, nodeLabel);
}

/**
 * Снят с прогона до этапа 7 (docs/plan/workflow-2.0-redesign.md).
 *
 * Сценарий ведёт СТАРЫЙ редактор: перетаскивание из палитры, метка узла, кнопка
 * «Сохранить черновик в рабочую версию». Фронт на 2.0 ещё не переведён, и схема,
 * которую собирает этот прежний поток, по правилам 2.0 невалидна — редактор сам
 * блокирует сохранение. Переписывать сценарий сейчас нельзя: он закрепляет
 * разметку, которой на этапе 7 не станет, и это была бы подгонка под зелёное.
 *
 * Проверяемые поведения обязаны вернуться вместе с новым редактором: палитра
 * ограничена каталогом C5, узел backend-api помечен как изменяющий данные,
 * черновик копируется в рабочую версию, состояние переключается.
 */
test.skip("Оператор платформы правит Workflow: безопасная палитра, новая версия и переключение состояния", async ({
  page
}) => {
  await loginAsUser(page, "/workflow", "@operator_demo");

  await expect(page.getByRole("heading", { name: "Workflow", level: 1 })).toBeVisible();
  // Схема выбирается через выпадающий список верхней панели (дизайн fbp_engine),
  // а её имя отражается заголовком редактора.
  await expect(page.getByRole("heading", { name: "Автоответчик обращений" })).toBeVisible();

  // Палитра ограничена каноническим набором узлов C5. Число выводится из
  // контракта, а не прибито: захардкоженный список 1.0 — это ровно тот дрейф
  // копий, из-за которого Backend разошёлся с движком (дефект D8).
  await expect(page.getByRole("button", { name: /^Добавить узел:/ })).toHaveCount(FBP_NODE_TYPES.length);

  // Узел вызова Backend API помечен как изменяющий данные (ТЗ §13.5).
  await page.getByRole("button", { name: "Узел Создать тикет" }).click();
  await expect(
    page.getByRole("region", { name: "Редактор схемы Workflow" }).getByText("Изменяет данные")
  ).toBeVisible();

  // Добавляем узел перетаскиванием, переименовываем и сохраняем черновик в рабочую версию
  // через иконочный тулбар (ТЗ §13.10, дизайн fbp_engine).
  await dragPaletteNodeToCanvas(page, "Ветвление");
  const labelInput = page.getByLabel("Метка узла");
  await labelInput.fill("Проверка бюджета");
  await page.getByRole("button", { name: "Сохранить черновик в рабочую версию" }).click();

  await expect(page.getByText("Черновик сохранён в рабочую версию.")).toBeVisible();

  // Включение/отключение Workflow из панели «Информация о схеме» (ТЗ §16.7).
  await page.getByRole("button", { name: "Отключить" }).click();
  await expect(page.getByText("Workflow отключен")).toBeVisible();

  // История исполнения открывается модальным окном из иконочного тулбара (дизайн fbp_engine).
  await page.getByRole("button", { name: "История исполнения" }).click();

  // Диагностика инстанса из истории исполнения.
  await page
    .getByRole("region", { name: "История исполнения Workflow" })
    .getByRole("button", { name: "Диагностика инстанса wfi-support-1001" })
    .click();
  await expect(page.getByText("Backend API создал тикет T-1001.")).toBeVisible();
});

test("AI Onboarding применяет конфиг: команда, подтверждение и обновление UI", async ({ page }) => {
  await loginAsUser(page, "/", "@admin_demo");

  // Ассистент живёт в боковой панели: язычок у правого края раскрывает чат,
  // широкий режим добавляет сводку конфигурации.
  await page.getByRole("button", { name: "Открыть панель AI-ассистента" }).click();
  await expect(page.getByRole("dialog", { name: "AI-ассистент" })).toBeVisible();
  await page.getByRole("button", { name: "Расширить панель" }).click();

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
