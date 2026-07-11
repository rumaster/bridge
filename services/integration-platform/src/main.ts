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
  createBackendChannelSecretClient,
  createBackendDeliveryClient,
  createAdapterDeliveryChannel,
  createBackoffPolicy,
  createChannelRateLimiter,
  createDeliveryEngine,
  createMockExternalChannel,
  createRealChannelClientsFromEnv,
  createResolvingTelegramClient,
} from "./delivery/index.js";
import {
  createBackendChannelsClient,
  createIngressPublisher,
  createTelegramInboundDriver,
  createTelegramUpdatesClient,
} from "./inbound/index.js";

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
const telegramApiBaseUrl = process.env.TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org";
// Per-org Telegram-доставка (Этап T2): токен бота организации резолвится по
// organization_id доставки через backend S2S (/internal/channels/secret) с TTL,
// а не берётся из единого env TELEGRAM_BOT_TOKEN.
const channelSecretClient = createBackendChannelSecretClient({
  baseUrl: backendBaseUrl,
  ttlMs: envInt("CHANNEL_SECRET_CACHE_TTL_MS", 60_000),
});
const telegramDeliveryClient = createResolvingTelegramClient({
  resolveToken: (input) => channelSecretClient.resolveToken(input),
  baseUrl: telegramApiBaseUrl,
});

const adapter = createMockAdapter({ coreIngressUrl });
const webChatAdapter = createWebChatAdapter({ coreIngressUrl });
const adapters = {
  telegram: createTelegramAdapter({
    channelClient: telegramDeliveryClient,
    coreIngressUrl,
  }),
  // Email — Edge-owned (SMTP на Edge, Этап E4): адаптер оставлен только для C6
  // capability/нормализации, но SVC-INT его НЕ диспетчеризует (нет channelClient).
  email: createEmailAdapter({ coreIngressUrl }),
  sms: createSmsAdapter({ coreIngressUrl }),
  vk: createVkAdapter({ coreIngressUrl }),
  max: createMaxAdapter({
    channelClient: channelClients.max,
    coreIngressUrl,
  }),
  whatsapp: createWhatsAppAdapter({ coreIngressUrl }),
};
// Mock-fallback доставки (CP-2, Этап T6, задача 5): по умолчанию включён для
// dev/CI (неподключённые каналы «доставляются» в mock, без внешних вызовов). В
// боевом профиле `DELIVERY_ALLOW_MOCK_FALLBACK=false` его снимает — неизвестный
// канал завершается ошибкой `adapter_missing`, а не тихим mock-успехом. Telegram
// на fallback НЕ опирается ни при каком профиле: адаптер зарегистрирован всегда и
// доставляет per-org токеном (T2).
const allowMockFallback =
  (process.env.DELIVERY_ALLOW_MOCK_FALLBACK ?? "true").toLowerCase() !== "false";
const deliveryChannel = createAdapterDeliveryChannel({
  adapters: {
    // Telegram доставляется всегда: токен per-org резолвится на лету.
    telegram: adapters.telegram,
    // MAX — через реальный клиент только при заданном env-шлюзе.
    // Email здесь НЕ регистрируется: исходящая почта уходит по SMTP на Edge
    // (Этап E4), минуя SVC-INT-диспетчер и mock-fallback (F1).
    ...(channelClients.max ? { max: adapters.max } : {}),
  },
  fallbackChannel: allowMockFallback ? createMockExternalChannel() : undefined,
});
// Массовая доставка через адаптеры: rate limiting на канал, ретраи с бэкоффом
// и идемпотентность. Telegram уходит per-org токеном (T2); Email/MAX — через
// env-шлюзы; остальные каналы и локальный CI сохраняют mock fallback (если не
// отключён DELIVERY_ALLOW_MOCK_FALLBACK).
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

// Входящий драйвер Telegram (Этап T3): getUpdates long-poll на каждый
// подключённый telegram-канал организации. Реестр каналов берётся из backend
// (S2S), токен резолвится тем же secret-клиентом, что и egress (T2).
//
// Публикация приёма (Этап T5): апдейт нормализуется telegram-адаптером в
// C2.IngressMessage и публикуется либо напрямую в CORE_INGRESS_URL, либо — для
// клиентов РФ (канал помечен config.region==="RF" / config.route_via_edge) и при
// заданном EDGE_INGRESS_URL — через Edge (RF-first буфер → туннель → ядро).
const telegramInboundEnabled =
  (process.env.TELEGRAM_INBOUND_ENABLED ?? "true").toLowerCase() !== "false";
const edgeIngressUrl = process.env.EDGE_INGRESS_URL?.trim() || null;
const ingressPublisher = createIngressPublisher({ coreIngressUrl, edgeIngressUrl });
const inboundDriver = telegramInboundEnabled
  ? createTelegramInboundDriver({
      listChannels: (input) =>
        createBackendChannelsClient({ baseUrl: backendBaseUrl }).listChannels(input),
      resolveToken: (input) => channelSecretClient.resolveToken(input),
      publishIncoming: (payload, channel) => {
        const ingress = adapters.telegram.buildIngress(payload);
        const routeViaEdge = ingressPublisher.edgeAvailable() && isRfEdgeChannel(channel);
        return ingressPublisher.publish(ingress, { routeViaEdge });
      },
      createUpdatesClient: ({ token }) =>
        createTelegramUpdatesClient({ token, baseUrl: telegramApiBaseUrl }),
      pollTimeoutSeconds: envInt("TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS", 30),
    })
  : null;

/** Клиент РФ: входящее приземляется RF-first через Edge (ТЗ §7.13/§7.14). */
function isRfEdgeChannel(channel) {
  const config = channel?.config ?? {};
  return config.route_via_edge === true || config.region === "RF";
}

server.listen(port, host, () => {
  console.log(`integration-platform listening on http://${host}:${port}`);
  if (inboundDriver) {
    inboundDriver
      .start({ refreshIntervalMs: envInt("TELEGRAM_INBOUND_REFRESH_INTERVAL_MS", 30_000) })
      .catch((error) => {
        console.error("telegram inbound driver failed to start", error);
      });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    inboundDriver?.stop();
    server.close(() => {
      process.exit(0);
    });
  });
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
