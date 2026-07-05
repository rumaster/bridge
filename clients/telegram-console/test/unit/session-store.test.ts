import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTelegramConsoleSessionStore } from "../../src/index.js";

describe("Telegram Console M5 session store", () => {
  it("revokes local Telegram access when the server session expires", () => {
    const clock = createControllableClock("2026-07-04T10:00:00.000Z");
    const store = createTelegramConsoleSessionStore({ now: clock.now });

    store.setSession(1001, session({ expires_at: "2026-07-04T10:05:00.000Z" }));
    store.setActiveConversation(1001, "conv-1");
    clock.set("2026-07-04T10:05:01.000Z");

    assert.equal(store.getSession(1001), null);
    assert.equal(store.getActiveConversationId(1001), null);
  });

  it("clears active dialog state when the session is revoked", () => {
    const store = createTelegramConsoleSessionStore({
      now: () => "2026-07-04T10:00:00.000Z",
    });

    store.setSession(1001, session());
    store.setActiveConversation(1001, "conv-1");
    store.revokeSession(1001, "backend-revoked");

    assert.equal(store.getSession(1001), null);
    assert.equal(store.getActiveConversationId(1001), null);
  });
});

function session(overrides = {}) {
  return {
    token: "mock-manager-session",
    user: {
      id: "manager-1",
      display_name: "Демо Менеджер",
      telegram_username: "manager_demo",
    },
    organization: {
      id: "org-1",
      name: "Bridge Demo",
    },
    expires_at: "2026-07-04T11:00:00.000Z",
    ...overrides,
  };
}

function createControllableClock(initial) {
  let current = initial;
  return {
    now: () => current,
    set: (next) => {
      current = next;
    },
  };
}
