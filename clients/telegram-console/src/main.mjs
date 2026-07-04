import { createTelegramConsoleRouter } from "./handler-router.mjs";
import { createMockTelegramApiAdapter } from "./mock-telegram-api.mjs";

const telegramApi = createMockTelegramApiAdapter({
  now: () => "2026-07-04T10:00:00.000Z",
});
const router = createTelegramConsoleRouter({
  telegramApi,
  now: () => "2026-07-04T10:00:00.000Z",
});

await router.handleUpdate({
  update_id: 1,
  message: {
    message_id: 1,
    chat: { id: 1001 },
    from: { id: 501, username: "manager_demo", first_name: "Demo" },
    text: "/start",
  },
});
await router.handleUpdate({
  update_id: 2,
  message: {
    message_id: 2,
    chat: { id: 1001 },
    from: { id: 501, username: "manager_demo", first_name: "Demo" },
    text: "/dialogs",
  },
});

console.log(
  JSON.stringify(
    {
      service: "telegram-console",
      mode: "cp9-m5",
      scope: router.getScope(),
      backend_requests: router.getBackendApi().getRecordedRequests(),
      sent_messages: telegramApi.getSentMessages(),
    },
    null,
    2,
  ),
);
