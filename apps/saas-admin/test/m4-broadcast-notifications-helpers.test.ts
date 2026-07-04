import { describe, expect, it } from "vitest";

import {
  BROADCAST_FILTER_MODES,
  BROADCAST_RATE_LIMIT_STRATEGIES,
  BROADCAST_START_MODES,
  broadcastDeliveryRate,
  broadcastFilterModeLabel,
  broadcastRateLimitStrategyLabel,
  broadcastStartModeLabel,
  broadcastStatusLabel,
  broadcastStatusTone,
  initialBroadcastFormState,
  splitList,
  validateBroadcastForm,
  type BroadcastFormState
} from "../src/shared/broadcast";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  notificationCategoryLabel,
  notificationCategoryTone,
  notificationChannelLabel,
  notificationSettingKey
} from "../src/shared/notifications";

function form(overrides: Partial<BroadcastFormState> = {}): BroadcastFormState {
  return { ...initialBroadcastFormState, ...overrides };
}

describe("Broadcast helpers (C8, CP-6)", () => {
  it("отражает статус кампании тоном ui-kit (только neutral/success/warning)", () => {
    expect(broadcastStatusLabel("done")).toBe("Завершена");
    expect(broadcastStatusTone("done")).toBe("success");
    expect(broadcastStatusTone("failed")).toBe("warning");
    expect(broadcastStatusTone("running")).toBe("neutral");
    expect(broadcastStatusTone("draft")).toBe("neutral");
    expect(broadcastStatusTone("scheduled")).toBe("neutral");
  });

  it("перечисляет режимы фильтра, запуска и стратегии лимита с подписями", () => {
    expect(BROADCAST_FILTER_MODES).toEqual(["all", "tags", "segment", "custom"]);
    expect(broadcastFilterModeLabel("tags")).toBe("По тегам");
    expect(BROADCAST_START_MODES).toEqual(["immediate", "scheduled"]);
    expect(broadcastStartModeLabel("immediate")).toBe("Отправить сразу");
    expect(broadcastStartModeLabel("scheduled")).toBe("По расписанию");
    expect(BROADCAST_RATE_LIMIT_STRATEGIES).toEqual(["fixed", "channel_capability"]);
    expect(broadcastRateLimitStrategyLabel("channel_capability")).toBe("По возможностям канала");
  });

  it("разбивает список получателей по запятым/переносам без пустых значений", () => {
    expect(splitList("vip, active\nnew,, ")).toEqual(["vip", "active", "new"]);
    expect(splitList("   ")).toEqual([]);
  });

  it("считает доставляемость детерминированно и без деления на ноль", () => {
    expect(broadcastDeliveryRate(1180, 1200)).toBe(98);
    expect(broadcastDeliveryRate(0, 0)).toBe(0);
    expect(broadcastDeliveryRate(5, 0)).toBe(0);
  });

  it("принимает корректный черновик кампании", () => {
    expect(validateBroadcastForm(form({ name: "Июльская акция", body: "Текст" }))).toEqual({});
  });

  it("требует название минимум из двух символов", () => {
    const errors = validateBroadcastForm(form({ name: "A", body: "Текст" }));
    expect(errors.name).toBeDefined();
  });

  it("требует непустой текст сообщения", () => {
    const errors = validateBroadcastForm(form({ name: "Кампания", body: "   " }));
    expect(errors.body).toBeDefined();
  });

  it("требует хотя бы один тег при фильтре по тегам", () => {
    const errors = validateBroadcastForm(
      form({ name: "Кампания", body: "Текст", filterMode: "tags", tags: "" })
    );
    expect(errors.tags).toBeDefined();

    const ok = validateBroadcastForm(
      form({ name: "Кампания", body: "Текст", filterMode: "tags", tags: "vip" })
    );
    expect(ok.tags).toBeUndefined();
  });

  it("требует положительный лимит сообщений в минуту", () => {
    expect(validateBroadcastForm(form({ name: "Кампания", body: "Текст", ratePerMinute: "0" })).ratePerMinute).toBeDefined();
    expect(validateBroadcastForm(form({ name: "Кампания", body: "Текст", ratePerMinute: "abc" })).ratePerMinute).toBeDefined();
    expect(validateBroadcastForm(form({ name: "Кампания", body: "Текст", ratePerMinute: "60" })).ratePerMinute).toBeUndefined();
  });
});

describe("Notification helpers (C10, CP-8, ТЗ §15.4)", () => {
  it("перечисляет категории и каналы доставки", () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(["info", "warning", "error", "critical", "admin"]);
    expect(NOTIFICATION_CHANNELS).toEqual(["web", "telegram", "email", "push"]);
  });

  it("формирует русские подписи категорий и каналов", () => {
    expect(notificationCategoryLabel("critical")).toBe("Критично");
    expect(notificationCategoryLabel("admin")).toBe("Администрирование");
    expect(notificationChannelLabel("web")).toBe("Веб");
    expect(notificationChannelLabel("telegram")).toBe("Telegram");
  });

  it("отражает категорию тоном ui-kit (только neutral/success/warning)", () => {
    expect(notificationCategoryTone("error")).toBe("warning");
    expect(notificationCategoryTone("critical")).toBe("warning");
    expect(notificationCategoryTone("warning")).toBe("warning");
    expect(notificationCategoryTone("info")).toBe("neutral");
    expect(notificationCategoryTone("admin")).toBe("neutral");
  });

  it("формирует стабильный ключ настройки категория:канал", () => {
    expect(notificationSettingKey("error", "telegram")).toBe("error:telegram");
  });
});
