import { createMockAdapter } from "./adapters/mock/mock-adapter.js";
import { createEmailAdapter } from "./adapters/email/email-adapter.js";
import { createMaxAdapter } from "./adapters/max/max-adapter.js";
import { createSmsAdapter } from "./adapters/sms/sms-adapter.js";
import { createTelegramAdapter } from "./adapters/telegram/telegram-adapter.js";
import { createVkAdapter } from "./adapters/vk/vk-adapter.js";
import { createWebChatAdapter } from "./adapters/web-chat/web-chat-adapter.js";
import { createWhatsAppAdapter } from "./adapters/whatsapp/whatsapp-adapter.js";
import { createIntegrationPlatformServer } from "./server.js";
import {
  createBackendDeliveryClient,
  createAdapterDeliveryChannel,
  createBackoffPolicy,
  createChannelRateLimiter,
  createDeliveryEngine,
  createMockExternalChannel,
  createRealChannelClientsFromEnv,
} from "./delivery/index.js";

const port = Number.parseInt(process.env.PORT ?? "3005", 10);
const host = process.env.HOST ?? "0.0.0.0";
const coreIngressUrl =
  process.env.CORE_INGRESS_URL ?? "http://127.0.0.1:3000/internal/ingress/messages";
const backendBaseUrl = process.env.BACKEND_BASE_URL ?? "http://127.0.0.1:3000";
const deliveryTimeoutMs = envInt("DELIVERY_TIMEOUT_MS", 2500);
const deliveryCircuitFailureThreshold = envInt("DELIVERY_CIRCUIT_FAILURE_THRESHOLD", 5);
const deliveryCircuitResetTimeoutMs = envInt("DELIVERY_CIRCUIT_RESET_TIMEOUT_MS", 10_000);
const deliveryBulkheadMaxConcurrent = envInt("DELIVERY_BULKHEAD_MAX_CONCURRENT", 8);
const deliveryBulkheadMaxQueue = envInt("DELIVERY_BULKHEAD_MAX_QUEUE", 16);
const deliveryQueueConcurrency = envInt("DELIVERY_QUEUE_CONCURRENCY", 4);
const deliveryQueueMaxSize = envInt("DELIVERY_QUEUE_MAX_SIZE", 1024);
const deliveryQueueMaxAttempts = envInt("DELIVERY_QUEUE_MAX_ATTEMPTS", 10);
const deliveryQueueRetryDelayMs = envInt("DELIVERY_QUEUE_RETRY_DELAY_MS", 1000);
const channelClients = createRealChannelClientsFromEnv();

const adapter = createMockAdapter({ coreIngressUrl });
const webChatAdapter = createWebChatAdapter({ coreIngressUrl });
const adapters = {
  telegram: createTelegramAdapter({
    channelClient: channelClients.telegram,
    coreIngressUrl,
  }),
  email: createEmailAdapter({
    channelClient: channelClients.email,
    coreIngressUrl,
  }),
  sms: createSmsAdapter({ coreIngressUrl }),
  vk: createVkAdapter({ coreIngressUrl }),
  max: createMaxAdapter({
    channelClient: channelClients.max,
    coreIngressUrl,
  }),
  whatsapp: createWhatsAppAdapter({ coreIngressUrl }),
};
const deliveryChannel = createAdapterDeliveryChannel({
  adapters: Object.fromEntries(
    Object.entries({
      email: adapters.email,
      max: adapters.max,
      telegram: adapters.telegram,
    }).filter(([channelType]) => channelClients[channelType]),
  ),
  fallbackChannel: createMockExternalChannel(),
});
// Массовая доставка через адаптеры: rate limiting на канал, ретраи с бэкоффом
// и идемпотентность. Telegram/Email/MAX при наличии env уходят через реальные
// клиенты, остальные каналы и локальный CI сохраняют mock fallback.
const deliveryEngine = createDeliveryEngine({
  channel: deliveryChannel,
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
  resilience: {
    timeoutMs: deliveryTimeoutMs,
    circuitBreaker: {
      failureThreshold: deliveryCircuitFailureThreshold,
      resetTimeoutMs: deliveryCircuitResetTimeoutMs,
    },
    bulkhead: {
      maxConcurrent: deliveryBulkheadMaxConcurrent,
      maxQueue: deliveryBulkheadMaxQueue,
    },
  },
  queue: {
    enabled: true,
    concurrency: deliveryQueueConcurrency,
    maxSize: deliveryQueueMaxSize,
    maxAttempts: deliveryQueueMaxAttempts,
    retryDelayMs: deliveryQueueRetryDelayMs,
  },
});

const server = createIntegrationPlatformServer({
  adapter,
  adapters,
  webChatAdapter,
  deliveryEngine,
  deliveryDispatchMode: "async",
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

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
