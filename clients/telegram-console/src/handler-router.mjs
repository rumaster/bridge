import { createMockTelegramConsoleBackendApi } from "./mock-backend-api.mjs";
import {
  createBackoffPolicy,
  defaultSleep,
  executeWithRetries,
  isRetryableTransientError,
} from "./retry-policy.mjs";
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
import { createReliableTelegramApiAdapter } from "./telegram-delivery.mjs";

const DEFAULT_LOGIN_CODE = "000000";
const DEFAULT_WORKSPACE_URL = "https://manager.bridge.local";
const DEFAULT_BACKEND_RETRY = Object.freeze({
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 2_000,
  maxAttempts: 3,
});

export function createTelegramConsoleRouter({
  telegramApi,
  backendApi,
  now = () => new Date().toISOString(),
  sleep = defaultSleep,
  sessionStore,
  telegramDelivery = {},
  backendRetry = {},
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
  const resolvedSessionStore = sessionStore ?? createTelegramConsoleSessionStore({ now });
  const resolvedTelegramApi =
    telegramDelivery === false
      ? telegramApi
      : createReliableTelegramApiAdapter({
          telegramApi,
          now: telegramDelivery.now ?? (() => Date.now()),
          sleep: telegramDelivery.sleep ?? defaultSleep,
          limits: telegramDelivery.limits,
          backoff: telegramDelivery.backoff,
        });
  const backendRetryPolicy =
    backendRetry === false
      ? null
      : resolveBackoffPolicy({ ...DEFAULT_BACKEND_RETRY, ...backendRetry });

  return {
    async handleUpdate(update) {
      if (isRecord(update?.message)) {
        return handleMessage({
          update,
          telegramApi: resolvedTelegramApi,
          backendApi: resolvedBackendApi,
          sessionStore: resolvedSessionStore,
          workspaceBaseUrl,
          loginCode,
          backendRetryPolicy,
          sleep,
        });
      }

      if (isRecord(update?.callback_query)) {
        return handleCallbackQuery({
          update,
          telegramApi: resolvedTelegramApi,
          backendApi: resolvedBackendApi,
          sessionStore: resolvedSessionStore,
          workspaceBaseUrl,
          backendRetryPolicy,
          sleep,
        });
      }

      return ignoredRoute("ignored", { reason: "unsupported-update-shape" });
    },

    async deliverNotification({ chatId, notification }) {
      return deliverTelegramNotification({
        chatId,
        notification,
        telegramApi: resolvedTelegramApi,
        backendApi: resolvedBackendApi,
        sessionStore: resolvedSessionStore,
        workspaceBaseUrl,
        backendRetryPolicy,
        sleep,
      });
    },

    getBackendApi() {
      return resolvedBackendApi;
    },

    getScope() {
      return TELEGRAM_CONSOLE_SCOPE;
    },

    getTelegramDeliveryMetrics() {
      return typeof resolvedTelegramApi.getMetrics === "function"
        ? resolvedTelegramApi.getMetrics()
        : null;
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
  backendRetryPolicy,
  sleep,
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
      backendRetryPolicy,
      sleep,
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

  let activeConversationId = sessionStore.getActiveConversationId(message.chat.id);
  let restoredSession = null;
  if (
    !activeConversationId &&
    isNonEmptyString(message.text) &&
    sessionStore.getSession(message.chat.id)
  ) {
    restoredSession = await requireSession({
      chatId: message.chat.id,
      telegramApi,
      backendApi,
      sessionStore,
      backendRetryPolicy,
      sleep,
    });
    if (restoredSession) {
      activeConversationId = await restoreActiveConversation({
        chatId: message.chat.id,
        session: restoredSession,
        backendApi,
        sessionStore,
      });
    }
  }

  if (activeConversationId && isNonEmptyString(message.text)) {
    const session =
      (await requireSession({
        chatId: message.chat.id,
        telegramApi,
        backendApi,
        sessionStore,
        backendRetryPolicy,
        sleep,
      })) ?? restoredSession;
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
      backendRetryPolicy,
      sleep,
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
  backendRetryPolicy,
  sleep,
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
      backendRetryPolicy,
      sleep,
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
      backendRetryPolicy,
      sleep,
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
      backendApi,
      sessionStore,
      backendRetryPolicy,
      sleep,
    });
  }

  const quickReply = readQuickReply(data);
  if (quickReply) {
    const session = await requireSession({
      chatId,
      telegramApi,
      backendApi,
      sessionStore,
      backendRetryPolicy,
      sleep,
    });
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
      backendRetryPolicy,
      sleep,
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
      backendRetryPolicy,
      sleep,
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
  let start;
  let session;
  try {
    start = await backendApi.auth.startTelegramLogin({
      telegram_username: telegramUsername,
      telegram_user: normalizeTelegramUser(message.from),
      chat_id: message.chat.id,
    });
    session = await backendApi.auth.verifyTelegramLogin({
      request_id: start.request_id,
      code: loginCode,
      telegram_user: normalizeTelegramUser(message.from),
      chat_id: message.chat.id,
    });
  } catch (error) {
    sessionStore.revokeSession(message.chat.id, "auth-denied");
    await telegramApi.sendMessage({
      chat_id: message.chat.id,
      text: "Telegram-аккаунт не привязан к менеджеру Bridge. Доступ к диалогам не выдан.",
    });

    return {
      route: "command:start",
      status: "auth_denied",
      reason: error instanceof Error ? error.message : "account linking denied",
      blocks_m0_gate: false,
      blocks_cp1: false,
    };
  }

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

async function listDialogs({
  chatId,
  telegramApi,
  backendApi,
  sessionStore,
  backendRetryPolicy,
  sleep,
}) {
  const session = await requireSession({
    chatId,
    telegramApi,
    backendApi,
    sessionStore,
    backendRetryPolicy,
    sleep,
  });
  if (!session) {
    return authRequiredRoute("command:dialogs");
  }

  let conversations;
  let cards;
  try {
    conversations = await executeBackendOperation({
      backendRetryPolicy,
      sleep,
      operation: () => backendApi.conversations.list(),
    });
    cards = await Promise.all(
      conversations.map(async (conversation) => ({
        conversation,
        client: await executeBackendOperation({
          backendRetryPolicy,
          sleep,
          operation: () => backendApi.clients.get(conversation.client_id),
        }),
      })),
    );
  } catch (error) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: "Backend временно недоступен. Повторите просмотр диалогов позже.",
    });
    return degradedRoute("command:dialogs", "C3", error);
  }

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
  backendRetryPolicy,
  sleep,
}) {
  const session = await requireSession({
    chatId,
    telegramApi,
    backendApi,
    sessionStore,
    backendRetryPolicy,
    sleep,
  });
  if (!session) {
    return authRequiredRoute("callback:dialog.open");
  }

  let conversation;
  let client;
  let messages;
  try {
    conversation = await executeBackendOperation({
      backendRetryPolicy,
      sleep,
      operation: () => backendApi.conversations.get(conversationId),
    });
    [client, messages] = await Promise.all([
      executeBackendOperation({
        backendRetryPolicy,
        sleep,
        operation: () => backendApi.clients.get(conversation.client_id),
      }),
      executeBackendOperation({
        backendRetryPolicy,
        sleep,
        operation: () => backendApi.conversations.listMessages(conversationId),
      }),
    ]);
  } catch (error) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: "Backend временно недоступен. Историю диалога сейчас открыть нельзя.",
    });
    return degradedRoute("callback:dialog.open", "C3", error);
  }
  await persistActiveConversation({
    chatId,
    conversationId,
    session,
    backendApi,
    sessionStore,
  });

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

async function promptReply({
  chatId,
  conversationId,
  telegramApi,
  backendApi,
  sessionStore,
  backendRetryPolicy,
  sleep,
}) {
  const session = await requireSession({
    chatId,
    telegramApi,
    backendApi,
    sessionStore,
    backendRetryPolicy,
    sleep,
  });
  if (!session) {
    return authRequiredRoute("callback:reply.prompt");
  }

  await persistActiveConversation({
    chatId,
    conversationId,
    session,
    backendApi,
    sessionStore,
  });
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
  backendRetryPolicy,
  sleep,
}) {
  const idempotencyKey = createReplyIdempotencyKey({ chatId, telegramMessageId, conversationId });
  let message;
  try {
    message = await executeBackendOperation({
      backendRetryPolicy,
      sleep,
      operation: () =>
        backendApi.messages.create({
          idempotency_key: idempotencyKey,
          organization_id: session.organization.id,
          conversation_id: conversationId,
          sender_type: "manager",
          type: "text",
          content: {
            text,
          },
        }),
    });
  } catch (error) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: "Backend временно недоступен. Ответ не подтверждён, повтор будет безопасен по idempotency_key.",
    });
    return {
      ...degradedRoute(route, "C3.messages", error),
      idempotency_key: idempotencyKey,
      retry_safe: true,
    };
  }

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
  backendRetryPolicy,
  sleep,
}) {
  const session = await requireSession({
    chatId,
    telegramApi,
    backendApi,
    sessionStore,
    backendRetryPolicy,
    sleep,
  });
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
  backendRetryPolicy,
  sleep,
}) {
  if (!notification.channels?.includes("telegram")) {
    return ignoredRoute("notification:telegram", {
      reason: "telegram-channel-not-enabled",
      notification_id: notification.id,
    });
  }

  const session = await requireSession({
    chatId,
    telegramApi,
    backendApi,
    sessionStore,
    backendRetryPolicy,
    sleep,
  });
  if (!session) {
    return authRequiredRoute("notification:telegram");
  }

  const conversationId = notification.payload?.conversation_id;
  const { conversation, client, degradedReason } = await readNotificationContext({
    notification,
    backendApi,
    backendRetryPolicy,
    sleep,
  });

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
    status: degradedReason ? "delivered_degraded" : "delivered",
    notification_id: notification.id,
    conversation_id: conversationId,
    degraded_reason: degradedReason,
    blocks_m0_gate: false,
    blocks_cp1: false,
  };
}

async function requireSession({
  chatId,
  telegramApi,
  backendApi,
  sessionStore,
  backendRetryPolicy,
  sleep,
}) {
  const session = sessionStore.getSession(chatId);
  if (session) {
    if (typeof backendApi?.auth?.getSession !== "function") {
      return session;
    }

    try {
      return await executeBackendOperation({
        backendRetryPolicy,
        sleep,
        operation: () => backendApi.auth.getSession({ token: session.token }),
      });
    } catch (error) {
      if (isSessionEndedError(error)) {
        sessionStore.revokeSession(chatId, "backend-session-ended");
      } else {
        return session;
      }
    }
  }

  if (Number.isInteger(chatId)) {
    await telegramApi.sendMessage({
      chat_id: chatId,
      text: "Сначала выполните /start, чтобы привязать Telegram-аккаунт менеджера.",
    });
  }

  return null;
}

async function persistActiveConversation({
  chatId,
  conversationId,
  session,
  backendApi,
  sessionStore,
}) {
  sessionStore.setActiveConversation(chatId, conversationId);
  if (typeof backendApi?.telegramConsole?.setActiveConversation !== "function") {
    return null;
  }

  try {
    return await backendApi.telegramConsole.setActiveConversation({
      session_token: session.token,
      conversation_id: conversationId,
    });
  } catch {
    return null;
  }
}

async function restoreActiveConversation({ chatId, session, backendApi, sessionStore }) {
  if (typeof backendApi?.telegramConsole?.getActiveConversation !== "function") {
    return null;
  }

  try {
    const state = await backendApi.telegramConsole.getActiveConversation({
      session_token: session.token,
    });
    if (isNonEmptyString(state?.conversation_id)) {
      sessionStore.setActiveConversation(chatId, state.conversation_id);
      return state.conversation_id;
    }
  } catch {
    return null;
  }

  return null;
}

async function readNotificationContext({ notification, backendApi, backendRetryPolicy, sleep }) {
  const conversationId = notification.payload?.conversation_id;

  try {
    const conversation = conversationId
      ? await executeBackendOperation({
          backendRetryPolicy,
          sleep,
          operation: () => backendApi.conversations.get(conversationId),
        })
      : null;
    const clientId = notification.payload?.client_id ?? conversation?.client_id;
    const client = clientId
      ? await executeBackendOperation({
          backendRetryPolicy,
          sleep,
          operation: () => backendApi.clients.get(clientId),
        })
      : null;

    return { conversation, client, degradedReason: null };
  } catch (error) {
    return {
      conversation: null,
      client: null,
      degradedReason: error instanceof Error ? error.message : "Backend unavailable",
    };
  }
}

async function executeBackendOperation({ operation, backendRetryPolicy, sleep }) {
  if (!backendRetryPolicy) {
    return operation();
  }

  return executeWithRetries({
    operation,
    backoff: backendRetryPolicy,
    sleep,
    isRetryable: isRetryableTransientError,
  });
}

function resolveBackoffPolicy(backoff) {
  if (backoff && typeof backoff.delayForAttempt === "function") {
    return backoff;
  }
  return createBackoffPolicy(backoff);
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

function degradedRoute(route, degradedContract, error) {
  return {
    route,
    status: "degraded",
    degraded_contract: degradedContract,
    reason: error instanceof Error ? error.message : "temporary backend failure",
    blocks_m0_gate: false,
    blocks_cp1: false,
  };
}

function isSessionEndedError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.error_code);
  return status === 401 || status === 403 || status === 404;
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
