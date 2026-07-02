export const TELEGRAM_CONSOLE_M0_SCOPE = Object.freeze({
  service_id: "SVC-TGC",
  package: "@bridge/telegram-console",
  milestone: "M0-prep",
  main_work_starts_at: "M3",
  blocks_m0_gate: false,
  blocks_cp1: false,
  implemented_now: Object.freeze([
    "mock-telegram-api-adapter",
    "command-and-button-routing",
    "c3-auth-account-linking-draft",
  ]),
  deferred_to_m3: Object.freeze([
    "c10-telegram-notifications",
    "c3-conversation-view",
    "c3-message-reply",
  ]),
  consumed_contracts: Object.freeze([
    "C3.auth",
    "C3.conversations",
    "C3.messages",
    "C10.notifications",
  ]),
});

export const TELEGRAM_CONSOLE_COMMANDS = Object.freeze({
  start: "/start",
  dialogs: "/dialogs",
  help: "/help",
});

export const TELEGRAM_CONSOLE_CALLBACKS = Object.freeze({
  linkAccount: "auth.link",
  listDialogs: "dialogs.list",
  help: "help",
});
