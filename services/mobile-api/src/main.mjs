import { createMobileBff } from "./mobile-bff.mjs";
import { createMobileApiServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3015", 10);
const host = process.env.HOST ?? "0.0.0.0";

// По умолчанию поднимаем реальный мобильный BFF (M4). MOBILE_API_MODE=mock —
// откат на детерминированный M0-мок (createMobileApiServer без аргумента).
const useBff = (process.env.MOBILE_API_MODE ?? "bff") !== "mock";
const mobileApi = useBff ? createMobileBff() : undefined;

if (useBff) {
  seedDemoData(mobileApi);
}

const server = createMobileApiServer({ mobileApi });

server.listen(port, host, () => {
  const mode = useBff ? "bff" : "deterministic-mock";
  console.log(`mobile-api (${mode}) listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

// Демо-наполнение мок-Backend, чтобы «экранные» ответы BFF были осмысленными при
// локальном запуске: клиент, разговор, пара сообщений и уведомление.
function seedDemoData(bff) {
  const organizationId = bff.context.organizationId;
  const userId = bff.context.userId;

  bff.backend.seedClient({
    organizationId,
    clientId: "client-1",
    displayName: "Ada Customer",
  });
  bff.backend.seedConversation({
    organizationId,
    conversationId: "conversation-1",
    clientId: "client-1",
    displayName: "Ada Customer",
  });
  bff.backend.sendMessage({
    organizationId,
    conversationId: "conversation-1",
    messageId: "message-1",
    idempotencyKey: "message-1",
    senderType: "manager",
    senderUserId: userId,
    text: "Hello, how can I help?",
  });
  bff.backend.sendMessage({
    organizationId,
    conversationId: "conversation-1",
    messageId: "message-2",
    idempotencyKey: "message-2",
    senderType: "client",
    text: "Can I change the delivery time?",
  });
  bff.backend.createNotification({
    organizationId,
    notificationId: "notification-1",
    recipientUserId: userId,
    category: "info",
    title: "New client message",
    body: "Ada Customer sent a message.",
    payload: { conversation_id: "conversation-1" },
  });
}
