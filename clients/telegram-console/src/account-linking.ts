import { TELEGRAM_CONSOLE_M0_SCOPE } from "./scope.js";

const C3_AUTH_OPERATIONS = Object.freeze([
  "POST /auth/login/telegram/start",
  "POST /auth/login/telegram/verify",
]);

export function createAccountLinkingDraft({
  c3AuthBasePath = "/api/v1",
  now = () => new Date().toISOString(),
} = {}) {
  return {
    createLinkingIntent({
      telegramUser,
      chatId,
      updateId,
      source = "telegram-console",
    } = {}) {
      return {
        contract: "TGC.AccountLinkingDraft",
        version: "0.0.0",
        service_id: TELEGRAM_CONSOLE_M0_SCOPE.service_id,
        status: "draft",
        source,
        depends_on: "C3.auth",
        upstream_base_path: c3AuthBasePath,
        upstream_operations: [...C3_AUTH_OPERATIONS],
        telegram_user: normalizeTelegramUser(telegramUser),
        chat_id: chatId ?? null,
        update_id: updateId ?? null,
        created_at: now(),
        real_auth_performed: false,
        mock: true,
        blocks_m0_gate: false,
        blocks_cp1: false,
      };
    },
  };
}

export function normalizeTelegramUser(user) {
  if (!isRecord(user)) {
    return null;
  }

  return {
    id: user.id ?? null,
    username: user.username ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
