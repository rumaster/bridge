export function createTelegramConsoleSessionStore({ now = () => new Date().toISOString() } = {}) {
  const sessionsByChatId = new Map();
  const activeConversationsByChatId = new Map();
  const pendingLoginsByChatId = new Map();

  return {
    setSession(chatId, session) {
      sessionsByChatId.set(String(chatId), clone(session));
      pendingLoginsByChatId.delete(String(chatId));
    },

    getSession(chatId) {
      const key = String(chatId);
      const session = sessionsByChatId.get(key);
      if (session && isSessionEnded(session, now())) {
        sessionsByChatId.delete(key);
        activeConversationsByChatId.delete(key);
        return null;
      }
      return session ? clone(session) : null;
    },

    setActiveConversation(chatId, conversationId) {
      activeConversationsByChatId.set(String(chatId), {
        conversation_id: conversationId,
        updated_at: now(),
      });
    },

    getActiveConversationId(chatId) {
      if (!this.getSession(chatId)) {
        return null;
      }
      return activeConversationsByChatId.get(String(chatId))?.conversation_id ?? null;
    },

    clearActiveConversation(chatId) {
      activeConversationsByChatId.delete(String(chatId));
    },

    revokeSession(chatId, reason = "revoked") {
      sessionsByChatId.delete(String(chatId));
      activeConversationsByChatId.delete(String(chatId));
      pendingLoginsByChatId.delete(String(chatId));
      return { chat_id: chatId, reason, revoked_at: now() };
    },

    setPendingLogin(chatId, pendingLogin) {
      pendingLoginsByChatId.set(String(chatId), clone(pendingLogin));
    },

    getPendingLogin(chatId) {
      const pending = pendingLoginsByChatId.get(String(chatId));
      return pending ? clone(pending) : null;
    },

    clearPendingLogin(chatId) {
      pendingLoginsByChatId.delete(String(chatId));
    },

    reset() {
      sessionsByChatId.clear();
      activeConversationsByChatId.clear();
      pendingLoginsByChatId.clear();
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSessionEnded(session, timestamp) {
  if (session.revoked_at || session.revokedAt || session.session?.revokedAt) {
    return true;
  }

  const expiresAt = session.expires_at ?? session.expiresAt ?? session.session?.expiresAt;
  if (!expiresAt) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.parse(timestamp);
}
