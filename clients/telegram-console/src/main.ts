import { createTelegramConsoleBackendApiClient } from "./backend-api-client.js";
import { createTelegramConsoleRouter } from "./handler-router.js";
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
  const router = createTelegramConsoleRouter({
    telegramApi,
    backendApi,
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

  const stop = () => {
    runner.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runner.run();
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
