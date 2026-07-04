import { createMockAdapter } from "./adapters/mock/mock-adapter.mjs";
import { createEmailAdapter } from "./adapters/email/email-adapter.mjs";
import { createMaxAdapter } from "./adapters/max/max-adapter.mjs";
import { createSmsAdapter } from "./adapters/sms/sms-adapter.mjs";
import { createTelegramAdapter } from "./adapters/telegram/telegram-adapter.mjs";
import { createVkAdapter } from "./adapters/vk/vk-adapter.mjs";
import { createWebChatAdapter } from "./adapters/web-chat/web-chat-adapter.mjs";
import { createWhatsAppAdapter } from "./adapters/whatsapp/whatsapp-adapter.mjs";
import { createIntegrationPlatformServer } from "./server.mjs";
import {
  createBackendDeliveryClient,
  createBackoffPolicy,
  createChannelRateLimiter,
  createDeliveryEngine,
  createMockExternalChannel,
} from "./delivery/index.mjs";

const port = Number.parseInt(process.env.PORT ?? "3005", 10);
const host = process.env.HOST ?? "0.0.0.0";
const coreIngressUrl =
  process.env.CORE_INGRESS_URL ?? "http://127.0.0.1:3000/internal/ingress/messages";
const backendBaseUrl = process.env.BACKEND_BASE_URL ?? "http://127.0.0.1:3000";

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
// Массовая доставка через адаптеры (CP-6, M4): rate limiting на канал, ретраи
// с бэкоффом и идемпотентность. Фасад внешних каналов — мок (реальные внешние
// API подключаются в M5), фиксация попыток — через Backend.
const deliveryEngine = createDeliveryEngine({
  channel: createMockExternalChannel(),
  backendClient: createBackendDeliveryClient({ baseUrl: backendBaseUrl }),
  rateLimiter: createChannelRateLimiter({
    limits: {
      telegram: { capacity: 30, refillTokens: 30, refillIntervalMs: 1000 },
      whatsapp: { capacity: 80, refillTokens: 80, refillIntervalMs: 1000 },
      sms: { capacity: 10, refillTokens: 10, refillIntervalMs: 1000 },
      email: { capacity: 100, refillTokens: 100, refillIntervalMs: 1000 },
      vk: { capacity: 20, refillTokens: 20, refillIntervalMs: 1000 },
      max: { capacity: 25, refillTokens: 25, refillIntervalMs: 1000 },
    },
  }),
  backoff: createBackoffPolicy({ baseDelayMs: 500, factor: 2, maxAttempts: 5 }),
});

const server = createIntegrationPlatformServer({
  adapter,
  adapters,
  webChatAdapter,
  deliveryEngine,
});

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
