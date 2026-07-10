import { createTelegramConsoleBackendApiClient } from "./backend-api-client.js";
import { createTelegramConsoleRouter } from "./handler-router.js";
import { createTelegramConsoleNotificationDispatcher } from "./notification-dispatcher.js";
import { createTelegramConsoleNotificationServer } from "./notification-server.js";
import { createTelegramConsoleSessionStore } from "./session-store.js";
import { createTelegramLongPollingRunner } from "./long-polling-runner.js";
import { createMockTelegramApiAdapter } from "./mock-telegram-api.js";
import { createTelegramBotApiAdapter } from "./telegram-bot-api.js";

const mode = process.env.TELEGRAM_CONSOLE_MODE ?? "polling";

if (mode === "mock") {
  await runMockDemo();
} else {
  await runProductionPolling();
}

async function runProductionPolling() {
  const token = process.env.TELEGRAM_CONSOLE_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CONSOLE_BOT_TOKEN is required for Telegram Console production polling. Set TELEGRAM_CONSOLE_MODE=mock for the deterministic demo.",
    );
  }

  const backendApi = createTelegramConsoleBackendApiClient({
    baseUrl:
      process.env.TELEGRAM_CONSOLE_BACKEND_API_BASE_URL ??
      process.env.BACKEND_API_BASE_URL ??
      "http://localhost:3000/api/v1",
  });
  const telegramApi = createTelegramBotApiAdapter({
    token,
    apiBaseUrl: process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org",
  });
  // Общий session-store для роутера и диспетчера уведомлений (G-8): диспетчер
  // резолвит chat_id менеджера по его сессии, привязанной через /start.
  const sessionStore = createTelegramConsoleSessionStore();
  const router = createTelegramConsoleRouter({
    telegramApi,
    backendApi,
    sessionStore,
    loginCode: process.env.TELEGRAM_CONSOLE_LOGIN_CODE || null,
    workspaceBaseUrl:
      process.env.MANAGER_WORKSPACE_PUBLIC_URL ??
      process.env.MANAGER_WORKSPACE_URL ??
      "http://localhost:8082",
  });
  const runner = createTelegramLongPollingRunner({
    telegramApi,
    router,
    pollTimeoutSeconds: Number(process.env.TELEGRAM_CONSOLE_POLL_TIMEOUT_SECONDS ?? 30),
  });

  // Приёмник проактивных карточек от SVC-NOTIF (G-8): включается заданием
  // TELEGRAM_CONSOLE_NOTIFICATIONS_PORT.
  const notificationServer = startNotificationServer({ router, sessionStore });

  const stop = () => {
    runner.stop();
    notificationServer?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runner.run();
}

function startNotificationServer({ router, sessionStore }) {
  const port = Number.parseInt(process.env.TELEGRAM_CONSOLE_NOTIFICATIONS_PORT ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const dispatcher = createTelegramConsoleNotificationDispatcher({ router, sessionStore });
  const server = createTelegramConsoleNotificationServer({ dispatcher });
  const host = process.env.TELEGRAM_CONSOLE_NOTIFICATIONS_HOST ?? "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`telegram-console notification intake listening on http://${host}:${port}`);
  });
  return server;
}

async function runMockDemo() {
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
        mode: "mock-demo",
        scope: router.getScope(),
        backend_requests: router.getBackendApi().getRecordedRequests(),
        sent_messages: telegramApi.getSentMessages(),
      },
      null,
      2,
    ),
  );
}
