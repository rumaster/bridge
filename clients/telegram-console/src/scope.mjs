export const TELEGRAM_CONSOLE_SCOPE = Object.freeze({
  service_id: "SVC-TGC",
  package: "@bridge/telegram-console",
  milestone: "M4-CP8",
  main_work_starts_at: "M3",
  blocks_m0_gate: false,
  blocks_cp1: false,
  implemented_now: Object.freeze([
    "mock-telegram-api-adapter",
    "command-and-button-routing",
    "c3-auth-account-linking",
    "c10-telegram-notifications",
    "c3-conversation-view",
    "c3-message-reply",
    "c4-ai-suggestions",
    "quick-replies",
  ]),
  deferred_to_m5: Object.freeze(["telegram-rate-limits", "acceptance-hardening"]),
  consumed_contracts: Object.freeze([
    "C3.auth",
    "C3.conversations",
    "C3.messages",
    "C4",
    "C10.notifications",
  ]),
});

export const TELEGRAM_CONSOLE_M0_SCOPE = TELEGRAM_CONSOLE_SCOPE;

export const TELEGRAM_CONSOLE_COMMANDS = Object.freeze({
  start: "/start",
  dialogs: "/dialogs",
  help: "/help",
});

export const TELEGRAM_CONSOLE_CALLBACKS = Object.freeze({
  linkAccount: "auth.link",
  listDialogs: "dialogs.list",
  help: "help",
  openDialogPrefix: "dialog.open:",
  replyPromptPrefix: "reply.prompt:",
  quickReplyPrefix: "reply.quick:",
  aiSummaryPrefix: "ai.summary:",
  aiReplyPrefix: "ai.reply:",
  aiKbPrefix: "ai.kb:",
  aiTranslatePrefix: "ai.translate:",
});
