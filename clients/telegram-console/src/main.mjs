import { createAccountLinkingDraft } from "./account-linking.mjs";
import { createTelegramConsoleRouter } from "./handler-router.mjs";
import { createMockTelegramApiAdapter } from "./mock-telegram-api.mjs";

const telegramApi = createMockTelegramApiAdapter({
  now: () => "2026-07-02T16:30:00.000Z",
});
const router = createTelegramConsoleRouter({
  telegramApi,
  accountLinking: createAccountLinkingDraft({
    now: () => "2026-07-02T16:30:00.000Z",
  }),
});

await router.handleUpdate({
  update_id: 1,
  message: {
    message_id: 1,
    chat: { id: 1001 },
    from: { id: 501, username: "manager_one" },
    text: "/help",
  },
});

console.log(
  JSON.stringify(
    {
      service: "telegram-console",
      mode: "m0-skeleton",
      scope: router.getScope(),
      sent_messages: telegramApi.getSentMessages(),
    },
    null,
    2,
  ),
);
