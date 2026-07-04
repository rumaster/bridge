import { createMockTelegramConsoleBackendApi } from "./mock-backend-api.mjs";
import {
  QUICK_REPLIES,
  createDialogKeyboard,
  createDialogsKeyboard,
  createNotificationKeyboard,
  createReplyKeyboard,
  createStartKeyboard,
  formatWorkspaceUrl,
  renderAiSuggestion,
  renderAiUnavailable,
  renderDialogView,
  renderDialogsList,
  renderNotificationCard,
  renderReplyAccepted,
  renderReplyPrompt,
  renderStartMessage,
} from "./rendering.mjs";
import { createTelegramConsoleSessionStore } from "./session-store.mjs";
import {
  TELEGRAM_CONSOLE_CALLBACKS,
  TELEGRAM_CONSOLE_COMMANDS,
  TELEGRAM_CONSOLE_SCOPE,
} from "./scope.mjs";

const DEFAULT_LOGIN_CODE = "000000";
const DEFAULT_WORKSPACE_URL = "https://manager.bridge.local";

export function createTelegramConsoleRouter({
  telegramApi,
  backendApi,
  sessionStore = createTelegramConsoleSessionStore(),
  now = () => new Date().toISOString(),
  aiAvailable = true,
  workspaceBaseUrl = DEFAULT_WORKSPACE_URL,
  loginCode = DEFAULT_LOGIN_CODE,
} = {}) {
  if (!telegramApi || typeof telegramApi.sendMessage !== "function") {
    throw new TypeError("telegramApi with sendMessage is required");
  }
  if (typeof telegramApi.answerCallbackQuery !== "function") {
    throw new TypeError("telegramApi with answerCallbackQuery is required");
  }

  const resolvedBackendApi =
    backendApi ?? createMockTelegramConsoleBackendApi({ now, aiAvailable });

  return {
    async handleUpdate(update) {
      if (isRecord(update?.message)) {
        return handleMessage({
          update,
          telegramApi,
          backendApi: resolvedBackendApi,
          sessionStore,
          workspaceBaseUrl,
          loginCode,
        });
      }

      if (isRecord(update?.callback_query)) {
        return handleCallbackQuery({
          update,
          telegramApi,
          backendApi: resolvedBackendApi,
          sessionStore,
          workspaceBaseUrl,
        });
      }

      return ignoredRoute("ignored", { reason: "unsupported-update-shape" });
    },

    async deliverNotification({ chatId, notification }) {
      return deliverTelegramNotification({
        chatId,
        notification,
        telegramApi,
        backendApi: resolvedBackendApi,
        sessionStore,
        workspaceBaseUrl,
      });
    },

    getBackendApi() {
      return resolvedBackendApi;
    },

    getScope() {
      return TELEGRAM_CONSOLE_SCOPE;
    },
  };
}

async function handleMessage({
  update,
  telegramApi,
  backendApi,
  sessionStore,
  workspaceBaseUrl,
  loginCode,
}) {
  const message = update.message;
  const command = parseTelegramCommand(message.text);

  if (command === TELEGRAM_CONSOLE_COMMANDS.start) {
    return linkAccount({
      update,
      telegramApi,
      backendApi,
      sessionStore,
      loginCode,
    });
  }

  if (command === TELEGRAM_CONSOLE_COMMANDS.dialogs) {
    return listDialogs({
      chatId: message.chat.id,
      telegramApi,
      backendApi,
      sessionStore,
    });
  }

  if (command === TELEGRAM_CONSOLE_COMMANDS.help) {
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Команды: /start, /dialogs. Кнопки открывают диалог, ответ, AI-подсказки и Manager Workspace.",
      reply_markup: createStartKeyboard(),
    });

    return okRoute("command:help");
  }

  if (command) {
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Команда не поддерживается Telegram Console.",
    });

    return ignoredRoute("command:unknown", { command });
  }

  const activeConversationId = sessionStore.getActiveConversationId(message.chat.id);
  if (activeConversationId && isNonEmptyString(message.text)) {
    const session = await requireSession({
      chatId: message.chat.id,
      telegramApi,
      sessionStore,
    });
    if (!session) {
      return authRequiredRoute("message:reply");
    }

    return sendManagerReply({
      chatId: message.chat.id,
      telegramMessageId: message.message_id,
      conversationId: activeConversationId,
      text: message.text,
      session,
      telegramApi,
      backendApi,
      route: "message:reply",
    });
  }

  return ignoredRoute("message:non-command");
}

async function handleCallbackQuery({
  update,
  telegramApi,
  backendApi,
  sessionStore,
  workspaceBaseUrl,
}) {
  const callbackQuery = update.callback_query;
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data ?? "";

  if (data === TELEGRAM_CONSOLE_CALLBACKS.linkAccount) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Откройте /start для привязки аккаунта.",
    });

    return okRoute("callback:auth.link");
  }

  if (data === TELEGRAM_CONSOLE_CALLBACKS.listDialogs) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Открываю активные диалоги.",
    });

    return listDialogs({
      chatId,
      telegramApi,
      backendApi,
      sessionStore,
    });
  }

  if (data === TELEGRAM_CONSOLE_CALLBACKS.help) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Справка отправлена.",
    });

    if (Number.isInteger(chatId)) {
      await telegramApi.sendMessage({
        chat_id: chatId,
        text: "Используйте /dialogs или кнопки в карточках уведомлений.",
      });
    }

    return okRoute("callback:help");
  }

  const openDialogId = readCallbackSuffix(data, TELEGRAM_CONSOLE_CALLBACKS.openDialogPrefix);
  if (openDialogId) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Открываю диалог.",
    });

    return openDialog({
      chatId,
      conversationId: openDialogId,
      telegramApi,
      backendApi,
      sessionStore,
      workspaceBaseUrl,
    });
  }

  const replyConversationId = readCallbackSuffix(data, TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix);
  if (replyConversationId) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Режим ответа включён.",
    });

    return promptReply({
      chatId,
      conversationId: replyConversationId,
      telegramApi,
      sessionStore,
    });
  }

  const quickReply = readQuickReply(data);
  if (quickReply) {
    const session = await requireSession({ chatId, telegramApi, sessionStore });
    if (!session) {
      return authRequiredRoute("callback:reply.quick");
    }

    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Отправляю быстрый ответ.",
    });

    return sendManagerReply({
      chatId,
      telegramMessageId: callbackQuery.id,
      conversationId: quickReply.conversationId,
      text: QUICK_REPLIES[quickReply.template],
      session,
      telegramApi,
      backendApi,
      route: "callback:reply.quick",
    });
  }

  const aiRequest = readAiRequest(data);
  if (aiRequest) {
    await telegramApi.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Запрашиваю AI-подсказку.",
    });

    return requestAiSuggestion({
      chatId,
      conversationId: aiRequest.conversationId,
      mode: aiRequest.mode,
      telegramApi,
      backendApi,
      sessionStore,
    });
  }

  await telegramApi.answerCallbackQuery({
    callback_query_id: callbackQuery.id,
    text: "Действие не поддерживается Telegram Console.",
  });

  return ignoredRoute("callback:unknown", { callback_data: data });
}

async function linkAccount({ update, telegramApi, backendApi, sessionStore, loginCode }) {
  const message = update.message;
  const telegramUsername = message.from?.username;
  const start = await backendApi.auth.startTelegramLogin({
    telegram_username: telegramUsername,
    telegram_user: normalizeTelegramUser(message.from),
    chat_id: message.chat.id,
  });
  const session = await backendApi.auth.verifyTelegramLogin({
    request_id: start.request_id,
    code: loginCode,
    telegram_user: normalizeTelegramUser(message.from),
    chat_id: message.chat.id,
  });

  sessionStore.setSession(message.chat.id, session);

  await telegramApi.sendMessage({
    chat_id: message.chat.id,
    text: renderStartMessage(session),
    reply_markup: createStartKeyboard(),
  });

  return okRoute("command:start", {
    account_link: {
      status: "linked",
      session,
      upstream_operations: [
        "POST /auth/login/telegram/start",
        "POST /auth/login/telegram/verify",
      ],
    },
  });
}

async function listDialogs({ chatId, telegramApi, backendApi, sessionStore }) {
  const session = await requireSession({ chatId, telegramApi, sessionStore });
  if (!session) {
    return authRequiredRoute("command:dialogs");
  }

  const conversations = await backendApi.conversations.list();
  const cards = await Promise.all(
    conversations.map(async (conversation) => ({
      conversation,
      client: await backendApi.clients.get(conversation.client_id),
    })),
  );

  await telegramApi.sendMessage({
    chat_id: chatId,
    text: renderDialogsList(cards),
    reply_markup: createDialogsKeyboard(conversations),
  });

  return okRoute("command:dialogs", {
    conversations,
    clients: cards.map((card) => card.client),
  });
}

async function openDialog({
  chatId,
  conversationId,
  telegramApi,
  backendApi,
  sessionStore,
  workspaceBaseUrl,
}) {
  const session = await requireSession({ chatId, telegramApi, sessionStore });
  if (!session) {
    return authRequiredRoute("callback:dialog.open");
  }

  const conversation = await backendApi.conversations.get(conversationId);
  const [client, messages] = await Promise.all([
    backendApi.clients.get(conversation.client_id),
    backendApi.conversations.listMessages(conversationId),
  ]);
  sessionStore.setActiveConversation(chatId, conversationId);

  await telegramApi.sendMessage({
    chat_id: chatId,
    text: renderDialogView({ conversation, client, messages }),
    reply_markup: createDialogKeyboard({
      conversationId,
      workspaceUrl: formatWorkspaceUrl(workspaceBaseUrl, conversationId),
    }),
  });

  return okRoute("callback:dialog.open", {
    dialog: {
      conversation,
      client,
      messages,
    },
  });
}

async function promptReply({ chatId, conversationId, telegramApi, sessionStore }) {
  const session = await requireSession({ chatId, telegramApi, sessionStore });
  if (!session) {
    return authRequiredRoute("callback:reply.prompt");
  }

  sessionStore.setActiveConversation(chatId, conversationId);
  await telegramApi.sendMessage({
    chat_id: chatId,
    text: renderReplyPrompt(conversationId),
    reply_markup: createReplyKeyboard(conversationId),
  });

  return okRoute("callback:reply.prompt", {
    conversation_id: conversationId,
  });
}

async function sendManagerReply({
  chatId,
  telegramMessageId,
  conversationId,
  text,
  session,
  telegramApi,
  backendApi,
  route,
}) {
  const idempotencyKey = createReplyIdempotencyKey({ chatId, telegramMessageId, conversationId });
  const message = await backendApi.messages.create({
    idempotency_key: idempotencyKey,
    organization_id: session.organization.id,
    conversation_id: conversationId,
    sender_type: "manager",
    type: "text",
    content: {
      text,
    },
  });

  await telegramApi.sendMessage({
    chat_id: chatId,
    text: renderReplyAccepted(message),
  });

  return okRoute(route, {
    idempotency_key: idempotencyKey,
    message,
  });
}

async function requestAiSuggestion({
  chatId,
  conversationId,
  mode,
  telegramApi,
  backendApi,
  sessionStore,
}) {
  const session = await requireSession({ chatId, telegramApi, sessionStore });
  if (!session) {
    return authRequiredRoute(`callback:ai.${mode}`);
  }

  try {
    const messages = await backendApi.conversations.listMessages(conversationId);
    const response = await backendApi.ai.suggest({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: `tgc-ai-${mode}-${conversationId}`,
      organization_id: session.organization.id,
      conversation_id: conversationId,
      requester_user_id: session.user.id,
      query: createAiQuery(mode),
      context: {
        messages: messages.slice(-8).map((message) => ({
          message_id: message.id,
          sender_type: message.sender_type,
          text: message.content.text,
          occurred_at: message.created_at,
        })),
      },
    });

    await telegramApi.sendMessage({
      chat_id: chatId,
      text: renderAiSuggestion(response),
      reply_markup: createReplyKeyboard(conversationId),
    });

    return okRoute(`callback:ai.${mode}`, {
      suggestion: response,
    });
  } catch (error) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: renderAiUnavailable(),
    });

    return {
      route: `callback:ai.${mode}`,
      status: "degraded",
      degraded_contract: "C4",
      reason: error instanceof Error ? error.message : "AI unavailable",
      messaging_available: true,
      blocks_m0_gate: false,
      blocks_cp1: false,
    };
  }
}

async function deliverTelegramNotification({
  chatId,
  notification,
  telegramApi,
  backendApi,
  sessionStore,
  workspaceBaseUrl,
}) {
  if (!notification.channels?.includes("telegram")) {
    return ignoredRoute("notification:telegram", {
      reason: "telegram-channel-not-enabled",
      notification_id: notification.id,
    });
  }

  const session = await requireSession({ chatId, telegramApi, sessionStore });
  if (!session) {
    return authRequiredRoute("notification:telegram");
  }

  const conversationId = notification.payload?.conversation_id;
  const conversation = conversationId
    ? await backendApi.conversations.get(conversationId)
    : null;
  const clientId = notification.payload?.client_id ?? conversation?.client_id;
  const client = clientId ? await backendApi.clients.get(clientId) : null;

  await telegramApi.sendMessage({
    chat_id: chatId,
    text: renderNotificationCard({ notification, conversation, client }),
    reply_markup: createNotificationKeyboard({
      conversationId,
      workspaceUrl: conversationId
        ? formatWorkspaceUrl(workspaceBaseUrl, conversationId)
        : workspaceBaseUrl,
    }),
  });

  return {
    route: "notification:telegram",
    status: "delivered",
    notification_id: notification.id,
    conversation_id: conversationId,
    blocks_m0_gate: false,
    blocks_cp1: false,
  };
}

async function requireSession({ chatId, telegramApi, sessionStore }) {
  const session = sessionStore.getSession(chatId);
  if (session) {
    return session;
  }

  if (Number.isInteger(chatId)) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: "Сначала выполните /start, чтобы привязать Telegram-аккаунт менеджера.",
    });
  }

  return null;
}

function readCallbackSuffix(data, prefix) {
  if (!data.startsWith(prefix)) {
    return null;
  }
  const suffix = data.slice(prefix.length);
  return suffix.trim() === "" ? null : suffix;
}

function readQuickReply(data) {
  const suffix = readCallbackSuffix(data, TELEGRAM_CONSOLE_CALLBACKS.quickReplyPrefix);
  if (!suffix) {
    return null;
  }

  const [conversationId, template] = suffix.split(":");
  if (!conversationId || !Object.hasOwn(QUICK_REPLIES, template)) {
    return null;
  }

  return { conversationId, template };
}

function readAiRequest(data) {
  const aiPrefixes = [
    ["summary", TELEGRAM_CONSOLE_CALLBACKS.aiSummaryPrefix],
    ["reply", TELEGRAM_CONSOLE_CALLBACKS.aiReplyPrefix],
    ["kb", TELEGRAM_CONSOLE_CALLBACKS.aiKbPrefix],
    ["translate", TELEGRAM_CONSOLE_CALLBACKS.aiTranslatePrefix],
  ];

  for (const [mode, prefix] of aiPrefixes) {
    const conversationId = readCallbackSuffix(data, prefix);
    if (conversationId) {
      return { mode, conversationId };
    }
  }

  return null;
}

function createAiQuery(mode) {
  if (mode === "summary") {
    return "Сделай краткое резюме диалога для менеджера.";
  }
  if (mode === "kb") {
    return "Найди в базе знаний информацию для ответа клиенту.";
  }
  if (mode === "translate") {
    return "Переведи последнее сообщение клиента на английский.";
  }
  return "Подскажи ответ клиенту.";
}

function createReplyIdempotencyKey({ chatId, telegramMessageId, conversationId }) {
  return `tgc-${chatId}-${telegramMessageId}-${conversationId}`;
}

function parseTelegramCommand(text) {
  if (typeof text !== "string" || !text.startsWith("/")) {
    return null;
  }

  const [rawCommand] = text.trim().split(/\s+/, 1);
  const [command] = rawCommand.split("@", 1);
  return command;
}

function normalizeTelegramUser(user) {
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

function okRoute(route, extra = {}) {
  return {
    route,
    status: "ok",
    blocks_m0_gate: false,
    blocks_cp1: false,
    ...extra,
  };
}

function authRequiredRoute(route) {
  return {
    route,
    status: "auth_required",
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
