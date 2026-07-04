import { TELEGRAM_CONSOLE_CALLBACKS } from "./scope.mjs";

export const QUICK_REPLIES = Object.freeze({
  delivery_status: "Здравствуйте! Проверяю актуальный статус доставки и вернусь с ответом.",
  need_order: "Подскажите, пожалуйста, номер заказа, чтобы я быстро проверил статус.",
  manager_followup: "Передаю вопрос профильному специалисту и напишу, как только будет ответ.",
});

export function renderStartMessage(session) {
  return [
    "Telegram Console подключена.",
    `Менеджер: ${session.user.display_name}`,
    `Организация: ${session.organization.name}`,
  ].join("\n");
}

export function createStartKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Диалоги",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.listDialogs,
        },
        {
          text: "Помощь",
          callback_data: TELEGRAM_CONSOLE_CALLBACKS.help,
        },
      ],
    ],
  };
}

export function renderDialogsList(conversationCards) {
  if (conversationCards.length === 0) {
    return "Активных диалогов нет.";
  }

  return [
    "Активные диалоги:",
    ...conversationCards.map(({ conversation, client }, index) => {
      return [
        `${index + 1}. ${client.display_name}`,
        `Канал: ${formatChannel(conversation.channel)}`,
        `Статус: ${conversation.status}`,
        `Непрочитано: ${conversation.unread_count}`,
        `Последнее: ${conversation.last_message_preview}`,
      ].join("\n");
    }),
  ].join("\n\n");
}

export function createDialogsKeyboard(conversations) {
  return {
    inline_keyboard: conversations.flatMap((conversation) => [
      [
        {
          text: "Открыть",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.openDialogPrefix}${conversation.id}`,
        },
        {
          text: "Ответить",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix}${conversation.id}`,
        },
      ],
    ]),
  };
}

export function renderNotificationCard({ notification, conversation, client }) {
  return [
    `Уведомление: ${notification.title}`,
    notification.body,
    "",
    `Клиент: ${client?.display_name ?? notification.payload?.client_id ?? "не указан"}`,
    conversation ? `Канал: ${formatChannel(conversation.channel)}` : null,
    conversation ? `Непрочитано: ${conversation.unread_count}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createNotificationKeyboard({ conversationId, workspaceUrl }) {
  if (!conversationId) {
    return {
      inline_keyboard: [
        [
          {
            text: "Диалоги",
            callback_data: TELEGRAM_CONSOLE_CALLBACKS.listDialogs,
          },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Открыть диалог",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.openDialogPrefix}${conversationId}`,
        },
        {
          text: "Ответить",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix}${conversationId}`,
        },
      ],
      [
        {
          text: "AI: резюме",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.aiSummaryPrefix}${conversationId}`,
        },
        {
          text: "Открыть в Manager Workspace",
          url: workspaceUrl,
        },
      ],
    ],
  };
}

export function renderDialogView({ conversation, client, messages }) {
  const history = messages.slice(-5).map((message) => {
    const sender = message.sender_type === "client" ? client.display_name : "Менеджер";
    return `${sender}: ${message.content.text}`;
  });

  return [
    `Диалог: ${client.display_name}`,
    `Канал: ${formatChannel(conversation.channel)}`,
    `Статус: ${conversation.status}`,
    `Непрочитано: ${conversation.unread_count}`,
    "",
    "История:",
    ...history,
  ].join("\n");
}

export function createDialogKeyboard({ conversationId, workspaceUrl }) {
  return {
    inline_keyboard: [
      [
        {
          text: "Ответить",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.replyPromptPrefix}${conversationId}`,
        },
        {
          text: "AI: подсказать ответ",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.aiReplyPrefix}${conversationId}`,
        },
      ],
      [
        {
          text: "AI: резюме",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.aiSummaryPrefix}${conversationId}`,
        },
        {
          text: "AI: KB",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.aiKbPrefix}${conversationId}`,
        },
      ],
      [
        {
          text: "AI: перевести",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.aiTranslatePrefix}${conversationId}`,
        },
        {
          text: "Manager Workspace",
          url: workspaceUrl,
        },
      ],
    ],
  };
}

export function renderReplyPrompt(conversationId) {
  return `Введите ответ для диалога ${conversationId} или выберите быстрый ответ.`;
}

export function createReplyKeyboard(conversationId) {
  return {
    inline_keyboard: [
      [
        {
          text: "Проверяю статус",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.quickReplyPrefix}${conversationId}:delivery_status`,
        },
      ],
      [
        {
          text: "Нужен номер заказа",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.quickReplyPrefix}${conversationId}:need_order`,
        },
      ],
      [
        {
          text: "Передам специалисту",
          callback_data: `${TELEGRAM_CONSOLE_CALLBACKS.quickReplyPrefix}${conversationId}:manager_followup`,
        },
      ],
    ],
  };
}

export function renderReplyAccepted(message) {
  return [
    "Ответ отправлен через Backend.",
    `Conversation: ${message.conversation_id}`,
    `Message: ${message.id}`,
    `Idempotency: ${message.idempotency_key}`,
  ].join("\n");
}

export function renderAiSuggestion(response) {
  const sourceTitle = response.sources[0]?.title ?? "источник не указан";
  return [
    "AI-подсказка:",
    response.suggestion.text,
    "",
    `Уверенность: ${Math.round(response.suggestion.confidence * 100)}%`,
    `Источник: ${sourceTitle}`,
    "Применение подсказки выполняется вручную менеджером.",
  ].join("\n");
}

export function renderAiUnavailable() {
  return "AI недоступен. Уведомления, просмотр диалогов и ответы продолжают работать.";
}

export function formatWorkspaceUrl(baseUrl, conversationId) {
  return `${baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}`;
}

function formatChannel(channel) {
  return channel.replace("_", " ");
}
