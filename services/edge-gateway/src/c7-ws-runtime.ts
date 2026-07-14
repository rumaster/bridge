import { createC7RedisStreamBridge } from "./c7-redis-stream-bridge.js";
import type { C7RedisStreamClient } from "./c7-redis-stream-bridge.js";
import { createC7WebSocketChannel } from "./c7-ws-channel.js";
import { createRedisStreamClient } from "./redis-stream-client.js";
import { createEdgeGatewayServer } from "./server.js";

/**
 * Standalone C7 WebSocket-рантайм App-стороны (docs/plan/manager-realtime-messages).
 *
 * Зачем отдельный энтрипойнт, а не полный edge-gateway edge-mode: менеджеру нужен
 * ТОЛЬКО WS-fan-out локального app-Redis (события уже лежат в `bridge:c7:events`,
 * туннель НЕ нужен). edge-mode рантайм (edge-runtime.ts) тянет RF-cluster →
 * DATABASE_URL, VPN-drain и канальные драйверы — всё лишнее и тяжёлое для App.
 * Здесь поднимаем минимум: C7-канал (fan-out с фильтром по organization_id) +
 * Redis→WS мост со СВОЕЙ consumer-group + HTTP/WS-сервер (server.ts).
 *
 * КРИТИЧНО (независимость групп Redis): группа по умолчанию тут `manager-c7`, НЕ
 * `edge-gateway-c7`. Consumer-группы Redis Streams делят доставку сообщений: если
 * бы App-мост читал ту же группу, что RF Edge, потребители «воровали» бы события
 * друг у друга и часть не доходила бы ни менеджеру, ни визитёру. Отдельная группа
 * = каждый потребитель видит полный поток.
 */

const DEFAULT_C7_REALTIME_GROUP = "manager-c7";

export interface C7WsRuntimeEnv {
  REDIS_URL?: string;
  C7_REALTIME_STREAM?: string;
  C7_REALTIME_GROUP?: string;
  C7_REALTIME_CONSUMER?: string;
  C7_REALTIME_POLL_MS?: string;
}

export interface CreateC7WsRuntimeOptions {
  env?: C7WsRuntimeEnv;
  /** Инъекция Redis-стрим-клиента для тестов (иначе строится из REDIS_URL). */
  streamClient?: C7RedisStreamClient;
  /** Инъекция C7-канала для тестов (иначе боевой fan-out канал). */
  wsChannel?: ReturnType<typeof createC7WebSocketChannel>;
  now?: () => string;
}

export interface C7WsRuntime {
  server: ReturnType<typeof createEdgeGatewayServer>;
  wsChannel: ReturnType<typeof createC7WebSocketChannel>;
  bridge: ReturnType<typeof createC7RedisStreamBridge>;
  group: string;
  stream: string;
  /** Запускает Redis→WS мост (поллинг стрима). */
  start(): void;
  /** Останавливает мост и закрывает Redis-клиента (сервер закрывается отдельно). */
  close(): Promise<void>;
}

/**
 * Собирает C7 WS-рантайм. Redis-стрим-клиент строится из REDIS_URL, если не
 * передан явный `streamClient` (в тестах инъектируется fake — без сети).
 */
export async function createC7WsRuntime(
  options: CreateC7WsRuntimeOptions = {},
): Promise<C7WsRuntime> {
  const env = options.env ?? {};
  const streamClient = options.streamClient ?? (await createStreamClientFromEnv(env));
  const wsChannel = options.wsChannel ?? createC7WebSocketChannel();

  const stream = env.C7_REALTIME_STREAM?.trim() || "bridge:c7:events";
  const group = env.C7_REALTIME_GROUP?.trim() || DEFAULT_C7_REALTIME_GROUP;
  const consumer = env.C7_REALTIME_CONSUMER?.trim() || `manager-c7-${process.pid}`;
  const pollMs = numberEnv(env.C7_REALTIME_POLL_MS, 1_000);

  const bridge = createC7RedisStreamBridge({
    stream,
    group,
    consumer,
    pollMs,
    streamClient,
    wsChannel,
  });

  const server = createEdgeGatewayServer({
    mode: "app-c7-ws",
    wsChannel,
    // realtime реально сконфигурирован: /health и /metrics отдают configured=true,
    // чтобы отсутствие моста не было «тихим».
    realtimeConfigured: true,
    now: options.now,
  });

  return {
    server,
    wsChannel,
    bridge,
    group,
    stream,
    start() {
      bridge.start();
    },
    async close() {
      await bridge.stop();
    },
  };
}

async function createStreamClientFromEnv(env: C7WsRuntimeEnv): Promise<C7RedisStreamClient> {
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL is required for the C7 WS runtime — без него Redis→WS мост не поднять " +
        "и события менеджеру по WS не доходят",
    );
  }
  return createRedisStreamClient(redisUrl);
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
