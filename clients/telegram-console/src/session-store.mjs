export function createTelegramConsoleSessionStore() {
  const sessionsByChatId = new Map();
  const activeConversationsByChatId = new Map();

  return {
    setSession(chatId, session) {
      sessionsByChatId.set(String(chatId), clone(session));
    },

    getSession(chatId) {
      const session = sessionsByChatId.get(String(chatId));
      return session ? clone(session) : null;
    },

    setActiveConversation(chatId, conversationId) {
      activeConversationsByChatId.set(String(chatId), {
        conversation_id: conversationId,
        updated_at: new Date().toISOString(),
      });
    },

    getActiveConversationId(chatId) {
      return activeConversationsByChatId.get(String(chatId))?.conversation_id ?? null;
    },

    reset() {
      sessionsByChatId.clear();
      activeConversationsByChatId.clear();
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
