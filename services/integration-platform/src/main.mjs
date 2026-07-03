import { createMockAdapter } from "./adapters/mock/mock-adapter.mjs";
import { createEmailAdapter } from "./adapters/email/email-adapter.mjs";
import { createMaxAdapter } from "./adapters/max/max-adapter.mjs";
import { createSmsAdapter } from "./adapters/sms/sms-adapter.mjs";
import { createTelegramAdapter } from "./adapters/telegram/telegram-adapter.mjs";
import { createVkAdapter } from "./adapters/vk/vk-adapter.mjs";
import { createWebChatAdapter } from "./adapters/web-chat/web-chat-adapter.mjs";
import { createWhatsAppAdapter } from "./adapters/whatsapp/whatsapp-adapter.mjs";
import { createIntegrationPlatformServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3005", 10);
const host = process.env.HOST ?? "0.0.0.0";
const coreIngressUrl =
  process.env.CORE_INGRESS_URL ?? "http://127.0.0.1:3000/internal/ingress/messages";

const adapter = createMockAdapter({ coreIngressUrl });
const webChatAdapter = createWebChatAdapter({ coreIngressUrl });
const adapters = {
  telegram: createTelegramAdapter({ coreIngressUrl }),
  email: createEmailAdapter({ coreIngressUrl }),
  sms: createSmsAdapter({ coreIngressUrl }),
  vk: createVkAdapter({ coreIngressUrl }),
  max: createMaxAdapter({ coreIngressUrl }),
  whatsapp: createWhatsAppAdapter({ coreIngressUrl }),
};
const server = createIntegrationPlatformServer({ adapter, adapters, webChatAdapter });

server.listen(port, host, () => {
  console.log(`integration-platform listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
