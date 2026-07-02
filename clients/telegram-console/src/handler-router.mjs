import { createAccountLinkingDraft } from "./account-linking.mjs";
import {
  TELEGRAM_CONSOLE_CALLBACKS,
  TELEGRAM_CONSOLE_COMMANDS,
  TELEGRAM_CONSOLE_M0_SCOPE,
} from "./scope.mjs";

export function createTelegramConsoleRouter({
  telegramApi,
  accountLinking = createAccountLinkingDraft(),
} = {}) {
  if (!telegramApi || typeof telegramApi.sendMessage !== "function") {
    throw new TypeError("telegramApi with sendMessage is required");
  }
  if (typeof telegramApi.answerCallbackQuery !== "function") {
    throw new TypeError("telegramApi with answerCallbackQuery is required");
  }

  return {
    async handleUpdate(update) {
      if (isRecord(update?.message)) {
        return handleMessage({ update, telegramApi, accountLinking });
      }

      if (isRecord(update?.callback_query)) {
        return handleCallbackQuery({ update, telegramApi, accountLinking });
      }

      return {
        route: "ignored",
        status: "ignored",
        reason: "unsupported-update-shape",
        blocks_m0_gate: false,
        blocks_cp1: false,
      };
    },

    getScope() {
      return TELEGRAM_CONSOLE_M0_SCOPE;
    },
  };
}

async function handleMessage({ update, telegramApi, accountLinking }) {
  const message = update.message;
  const command = parseTelegramCommand(message.text);

  if (command === TELEGRAM_CONSOLE_COMMANDS.start) {
    const accountLink = accountLinking.createLinkingIntent({
      telegramUser: message.from,
      chatId: message.chat?.id,
      updateId: update.update_id,
      source: "command:/start",
    });

    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Telegram Console M0 skeleton is ready. Account linking is deferred to C3.auth.",
      reply_markup: createStartKeyboard(),
    });

    return okRoute("command:start", {
      account_link: accountLink,
    });
  }

  if (command === TELEGRAM_CONSOLE_COMMANDS.dialogs) {
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Dialog routing is available as an M0 smoke only. Dialog view starts in M3.",
      reply_markup: createDeferredKeyboard(),
    });

    return deferredRoute("command:dialogs", "C3.conversations");
  }

  if (command === TELEGRAM_CONSOLE_COMMANDS.help) {
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "M0 skeleton commands: /start, /dialogs. Main Telegram Console work starts in M3.",
      reply_markup: createStartKeyboard(),
    });

    return okRoute("command:help");
  }

  if (command) {
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Unsupported command in Telegram Console M0 skeleton.",
    });

    return ignoredRoute("command:unknown", { command });
  }

  return ignoredRoute("message:non-command");
}

async function handleCallbackQuery({ update, telegramApi, accountLinking }) {
  const callbackQuery = update.callback_query;
  const chatId = callbackQuery.message?.chat?.id;

  if (callbackQuery.data === TELEGRAM_CONSOLE_CALLBACKS.linkAccount) {
    const accountLink = accountLinking.createLinkingIntent({
      telegramUser: callbackQuery.from,
      chatId,
      updateId: update.update_id,
      source: "callback:auth.link",
    });

    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Account linking is a C3.auth draft in M0.",
    });

    if (Number.isInteger(chatId)) {
      await telegramApi.sendMessage({
        chat_id: chatId,
        text: "Account-link draft recorded. Real verification will be implemented through C3.auth.",
      });
    }

    return okRoute("callback:auth.link", {
      account_link: accountLink,
    });
  }

  if (callbackQuery.data === TELEGRAM_CONSOLE_CALLBACKS.listDialogs) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Dialog view starts in M3.",
    });

    return deferredRoute("callback:dialogs.list", "C3.conversations");
  }

  if (callbackQuery.data === TELEGRAM_CONSOLE_CALLBACKS.help) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "M0 skeleton help sent.",
    });

    if (Number.isInteger(chatId)) {
      await telegramApi.sendMessage({
        chat_id: chatId,
        text: "M0 skeleton commands: /start, /dialogs. Main Telegram Console work starts in M3.",
      });
    }

    return okRoute("callback:help");
  }

  await telegramApi.answerCallbackQuery({
    callback_query_id: callbackQuery.id,
    text: "Unsupported action in Telegram Console M0 skeleton.",
  });

  return ignoredRoute("callback:unknown", { callback_data: callbackQuery.data });
}

function parseTelegramCommand(text) {
  if (typeof text !== "string" || !text.startsWith("/")) {
    return null;
  }

  const [rawCommand] = text.trim().split(/\s+/, 1);
  const [command] = rawCommand.split("@", 1);
  return command;
}

function createStartKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Link account",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.linkAccount,
        },
      ],
      [
        {
          text: "Dialogs",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.listDialogs,
        },
        {
          text: "Help",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.help,
        },
      ],
    ],
  };
}

function createDeferredKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Link account",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.linkAccount,
        },
      ],
    ],
  };
}

function okRoute(route, extra = {}) {
  return {
    route,
    status: "ok",
    blocks_m0_gate: false,
    blocks_cp1: false,
    ...extra,
  };
}

function deferredRoute(route, sourceContract) {
  return {
    route,
    status: "deferred",
    deferred_to: "M3",
    source_contract: sourceContract,
    blocks_m0_gate: false,
    blocks_cp1: false,
  };
}

function ignoredRoute(route, extra = {}) {
  return {
    route,
    status: "ignored",
    blocks_m0_gate: false,
    blocks_cp1: false,
    ...extra,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
