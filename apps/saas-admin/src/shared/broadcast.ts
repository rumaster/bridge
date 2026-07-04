import type {
  BroadcastFilterMode,
  BroadcastRateLimitStrategy,
  BroadcastScheduleMode,
  BroadcastStartMode,
  BroadcastStatus
} from "../api/client/types";

/**
 * UI-хелперы раздела Broadcast (C8, CP-6). Только представление и валидация
 * черновика на стороне UI — материализация получателей, планирование и рассылка
 * остаются за SVC-BCAST/ядром (ТЗ §21.5). Детерминированно, без Math.random/Date.now.
 */
export function broadcastStatusLabel(status: BroadcastStatus): string {
  switch (status) {
    case "draft":
      return "Черновик";
    case "scheduled":
      return "Запланирована";
    case "running":
      return "Выполняется";
    case "done":
      return "Завершена";
    case "failed":
      return "Ошибка";
  }
}

export function broadcastStatusTone(status: BroadcastStatus): "neutral" | "success" | "warning" {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "warning";
    default:
      return "neutral";
  }
}

export const BROADCAST_FILTER_MODES: BroadcastFilterMode[] = ["all", "tags", "segment", "custom"];

export function broadcastFilterModeLabel(mode: BroadcastFilterMode): string {
  switch (mode) {
    case "all":
      return "Все получатели";
    case "tags":
      return "По тегам";
    case "segment":
      return "По сегменту";
    case "custom":
      return "Произвольный критерий";
  }
}

export const BROADCAST_START_MODES: BroadcastStartMode[] = ["immediate", "scheduled"];

export function broadcastStartModeLabel(mode: BroadcastStartMode): string {
  return mode === "immediate" ? "Отправить сразу" : "По расписанию";
}

export function broadcastScheduleModeLabel(mode: BroadcastScheduleMode): string {
  switch (mode) {
    case "manual":
      return "Ручной запуск";
    case "immediate":
      return "Немедленно";
    case "scheduled":
      return "По расписанию";
    case "event":
      return "По событию";
    case "workflow":
      return "Из Workflow";
  }
}

export const BROADCAST_RATE_LIMIT_STRATEGIES: BroadcastRateLimitStrategy[] = [
  "fixed",
  "channel_capability"
];

export function broadcastRateLimitStrategyLabel(strategy: BroadcastRateLimitStrategy): string {
  return strategy === "fixed" ? "Фиксированный темп" : "По возможностям канала";
}

export interface BroadcastFormState {
  name: string;
  body: string;
  locale: string;
  variables: string;
  filterMode: BroadcastFilterMode;
  channels: string;
  tags: string;
  ratePerMinute: string;
  burst: string;
  strategy: BroadcastRateLimitStrategy;
}

export const initialBroadcastFormState: BroadcastFormState = {
  name: "",
  body: "",
  locale: "ru",
  variables: "",
  filterMode: "all",
  channels: "",
  tags: "",
  ratePerMinute: "60",
  burst: "",
  strategy: "fixed"
};

export type BroadcastFormErrors = Partial<Record<"name" | "body" | "tags" | "ratePerMinute", string>>;

/**
 * UI-валидация черновика кампании (подсказка администратору). Авторитетную
 * проверку выполняет фасад C8/Backend (ТЗ §12.5).
 */
export function validateBroadcastForm(state: BroadcastFormState): BroadcastFormErrors {
  const errors: BroadcastFormErrors = {};

  if (state.name.trim().length < 2) {
    errors.name = "Название кампании должно содержать минимум 2 символа.";
  }

  if (state.body.trim().length === 0) {
    errors.body = "Текст сообщения обязателен.";
  }

  if (state.filterMode === "tags" && splitList(state.tags).length === 0) {
    errors.tags = "Укажите хотя бы один тег для фильтра по тегам.";
  }

  const rate = Number(state.ratePerMinute);
  if (!Number.isFinite(rate) || rate < 1) {
    errors.ratePerMinute = "Лимит сообщений в минуту должен быть положительным числом.";
  }

  return errors;
}

/** Разбивает строку по запятым/переносам в список без пустых значений. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function broadcastDeliveryRate(delivered: number, sent: number): number {
  if (sent <= 0) {
    return 0;
  }
  return Math.round((delivered / sent) * 100);
}
