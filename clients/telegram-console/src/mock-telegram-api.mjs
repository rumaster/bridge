export function createMockTelegramApiAdapter({ now = () => new Date().toISOString() } = {}) {
  const sentMessages = [];
  const answeredCallbackQueries = [];

  return {
    async sendMessage(payload) {
      const message = normalizeSendMessage(payload, sentMessages.length + 1, now());
      sentMessages.push(message);
      return clone(message);
    },

    async answerCallbackQuery(payload) {
      const answer = normalizeCallbackAnswer(payload);
      answeredCallbackQueries.push(answer);
      return clone(answer);
    },

    getSentMessages() {
      return clone(sentMessages);
    },

    getAnsweredCallbackQueries() {
      return clone(answeredCallbackQueries);
    },

    reset() {
      sentMessages.length = 0;
      answeredCallbackQueries.length = 0;
    },
  };
}

function normalizeSendMessage(payload, sequence, sentAt) {
  if (!isRecord(payload)) {
    throw new TypeError("sendMessage payload must be an object");
  }

  if (!Number.isInteger(payload.chat_id)) {
    throw new TypeError("sendMessage chat_id must be an integer");
  }

  if (typeof payload.text !== "string" || payload.text.trim() === "") {
    throw new TypeError("sendMessage text must be a non-empty string");
  }

  return {
    message_id: `mock-message-${sequence}`,
    chat_id: payload.chat_id,
    text: payload.text,
    reply_markup: payload.reply_markup ?? null,
    parse_mode: payload.parse_mode ?? null,
    sent_at: sentAt,
    mock: true,
  };
}

function normalizeCallbackAnswer(payload) {
  if (!isRecord(payload)) {
    throw new TypeError("answerCallbackQuery payload must be an object");
  }

  if (
    typeof payload.callback_query_id !== "string" ||
    payload.callback_query_id.trim() === ""
  ) {
    throw new TypeError("callback_query_id must be a non-empty string");
  }

  return {
    callback_query_id: payload.callback_query_id,
    text: payload.text ?? "",
    show_alert: payload.show_alert ?? false,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
