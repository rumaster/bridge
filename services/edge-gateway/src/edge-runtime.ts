import { createLivenessLink, createTcpLivenessProbe } from "./awg-liveness.js";
import { createC7RedisStreamBridge } from "./c7-redis-stream-bridge.js";
import { createEdgeChannelRuntime } from "./edge-channel-drivers.js";
import { createEdgeCluster } from "./edge-cluster.js";
import { createPostgresEdgeMessageBufferStore } from "./edge-message-buffer.js";
import { createC7WebSocketChannel } from "./c7-ws-channel.js";
import { createRedisStreamClient } from "./redis-stream-client.js";
import { createRfPayloadCipher, resolveRfPayloadKey } from "./rf-payload-cipher.js";
import { createEdgeGatewayServer } from "./server.js";
import {
  createFailoverVpnTunnelRemoteServer,
  createVpnTunnelTcpAppServer,
  createVpnTunnelTcpRemoteServer,
  createVpnTunnelWebSocketAppServer,
  createVpnTunnelWebSocketRemoteServer,
} from "./vpn-transport.js";
import {
  VpnTunnelError,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
  resolveVpnSessionSecret,
} from "./vpn-tunnel.js";

export type EdgeGatewayMode = "mock" | "edge" | "app-vpn";

export interface EdgeGatewayRuntime {
  mode: EdgeGatewayMode;
  server?: any;
  cluster?: any;
  tunnel?: any;
  close?: () => Promise<void>;
}

export interface CreateEdgeGatewayRuntimeOptions {
  bufferStore?: any;
  c7StreamClient?: any;
  tunnel?: any;
  now?: () => string;
  fetchImpl?: typeof fetch;
  wsChannel?: any;
}

export function resolveEdgeGatewayMode(env: Record<string, string | undefined> = process.env) {
  const mode = (env.EDGE_GATEWAY_MODE ?? "mock").trim().toLowerCase();
  if (mode === "edge" || mode === "production-edge") {
    return "edge";
  }
  if (mode === "app-vpn" || mode === "app") {
    return "app-vpn";
  }
  return "mock";
}

export async function createEdgeGatewayRuntimeFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: CreateEdgeGatewayRuntimeOptions = {},
): Promise<EdgeGatewayRuntime> {
  const mode = resolveEdgeGatewayMode(env);
  if (mode === "mock") {
    return {
      mode,
      server: createEdgeGatewayServer({
        now: options.now,
        webChatBackendUrl: resolveWebChatBackendUrl(env),
      }),
      close: async () => {},
    };
  }
  if (mode === "app-vpn") {
    throw new VpnTunnelError("app-vpn mode is started with startEdgeGatewayFromEnv()");
  }

  if (!env.DATABASE_URL && !options.bufferStore) {
    throw new VpnTunnelError("DATABASE_URL is required for production-edge RF buffer");
  }

  const cipher = createRfPayloadCipher({ key: resolveRfPayloadKey(env) });
  const buffer = options.bufferStore
    ? { store: options.bufferStore, close: async () => {} }
    : await createPostgresBufferStore(env.DATABASE_URL);
  const remoteServer = createRemoteVpnServerFromEnv(env);
  // Единый слой (Q2): при EDGE_VPN_APP_CRYPTO=off прикладной AES-GCM/mTLS снят —
  // защиту канала даёт AmneziaWG. По умолчанию on (обратная совместимость).
  const appCrypto = env.EDGE_VPN_APP_CRYPTO !== "off";
  const edgeCertificate = appCrypto
    ? requiredEnv(env, "EDGE_VPN_EDGE_CERT")
    : (env.EDGE_VPN_EDGE_ID ?? "edge-rf");
  const sessionSecret = appCrypto ? resolveVpnSessionSecret(env) : undefined;
  const trustedAppCertificates = appCrypto
    ? parseList(requiredEnv(env, "EDGE_VPN_TRUSTED_APP_CERTS"))
    : [];
  // Проактивный liveness (§5.4): активная TCP-проба туннельного IP App-стороны
  // питает link edge-клиента → триггер «буферизация ↔ дренаж» в edge-cluster.
  const livenessLink = createLivenessLinkFromEnv(env);
  const tunnel =
    options.tunnel ??
    createVpnTunnelEdgeClient({
      identity: {
        id: env.EDGE_VPN_EDGE_ID ?? "edge-rf",
        certificate: edgeCertificate,
      },
      server: remoteServer,
      trustedCertificates: trustedAppCertificates,
      sessionSecret,
      clientId: env.EDGE_VPN_CLIENT_ID ?? "edge-rf",
      backoff: parseBackoff(env.EDGE_VPN_BACKOFF_MS),
      appCrypto,
      ...(livenessLink ? { link: livenessLink } : {}),
    });
  if (!options.tunnel) {
    livenessLink?.start();
  }
  const cluster = createEdgeCluster({
    cipher,
    tunnel,
    bufferStore: buffer.store,
    now: options.now,
    bufferTtlMs: numberEnv(env.EDGE_BUFFER_TTL_MS, undefined),
    region: env.EDGE_REGION ?? "RF",
  });
  // Рехидратация секвенсора из RF-буфера ДО приёма входящих (§7.10): после
  // рестарта Edge sequence_number должен продолжаться с максимума уже
  // зафиксированных записей, иначе повторная нумерация с 1 конфликтует с
  // существующими строками буфера (unique (endpoint_id, sequence_number)) →
  // "Edge ingest failed" на входящем письме/апдейте.
  try {
    const restored = await cluster.rehydrateSequencer();
    if (restored > 0) {
      console.log(`edge sequencer rehydrated from RF buffer: ${restored} endpoints`);
    }
  } catch (error) {
    console.error("edge sequencer rehydration failed", error);
  }
  // Edge-owned канальные драйверы (Этап M5): бот MAX работает на Edge — приём
  // getUpdates → RF-first `cluster.ingest`, отправка через MAX Bot API; реестр
  // каналов и токены — из control-plane (creds-sync App→Edge). За гейтом
  // EDGE_CHANNEL_DRIVERS=on (по умолчанию off — не менять поведение живого edge,
  // пока App-сторона не начнёт синхронизировать креды каналов).
  const channelRuntime =
    (env.EDGE_CHANNEL_DRIVERS ?? "off").trim().toLowerCase() === "on"
      ? createEdgeChannelRuntime({
          cluster,
          cipher: createRfPayloadCipher({ key: resolveRfPayloadKey(env) }),
          env,
          now: options.now,
        })
      : null;
  const wsChannel = options.wsChannel ?? createC7WebSocketChannel();
  const c7StreamClient = await createC7StreamClientFromEnv(env, options.c7StreamClient);
  // Видимая деградация realtime (W3, WG-8): без Redis C7 Redis→WS мост не стартует
  // и события менеджера/посетителю по WS не доходят. Раньше это молчаливый no-op —
  // теперь fail-fast, если realtime обязателен, иначе явный WARN + метрика.
  if (!c7StreamClient) {
    if (isC7RealtimeRequired(env)) {
      throw new VpnTunnelError(
        "REDIS_URL is required for C7 realtime (EDGE_WEB_CHAT_BACKEND_URL/EDGE_C7_REALTIME_REQUIRED set): " +
          "без него события менеджера/посетителю по WS не доходят",
      );
    }
    console.warn(
      "[edge] C7 realtime disabled: REDIS_URL not configured — realtime WS events will NOT be delivered",
    );
  }
  const c7StreamBridge = c7StreamClient
    ? createC7RedisStreamBridge({
        stream: env.C7_REALTIME_STREAM?.trim() || undefined,
        group: env.C7_REALTIME_GROUP?.trim() || undefined,
        consumer: env.C7_REALTIME_CONSUMER?.trim() || undefined,
        pollMs: numberEnv(env.C7_REALTIME_POLL_MS, 1_000),
        streamClient: c7StreamClient,
        wsChannel,
      })
    : null;
  c7StreamBridge?.start();

  // Поддержание VPN-туннеля и дренаж RF-буфера: подключаем туннель на старте и
  // периодически досылаем накопленное (cluster.drain() = ensureConnected + flush).
  // Без этого не-backlog ingest уходит в буфер как "disconnected" и не форвардится
  // (туннель подключается только внутри drain()).
  const drainIntervalMs = numberEnv(env.EDGE_DRAIN_INTERVAL_MS, 5000);
  let drainTimer;
  if (drainIntervalMs > 0 && typeof cluster.drain === "function") {
    const runDrain = () => {
      void cluster.drain().catch(() => {});
    };
    runDrain();
    drainTimer = setInterval(runDrain, drainIntervalMs);
    drainTimer.unref?.();
  }

  if (channelRuntime) {
    channelRuntime.start().catch((error) => {
      console.error("edge channel runtime failed to start", error);
    });
  }

  return {
    mode,
    server: createEdgeGatewayServer({
      mode: "production-edge",
      edgeCluster: cluster,
      wsChannel,
      now: options.now,
      vpnTunnel: tunnel,
      liveness: livenessLink,
      controlPlane: channelRuntime?.controlPlane,
      attachmentStore: channelRuntime?.attachmentStore,
      webChatBackendUrl: resolveWebChatBackendUrl(env),
      realtimeConfigured: Boolean(c7StreamBridge),
    }),
    cluster,
    tunnel,
    close: async () => {
      if (drainTimer) {
        clearInterval(drainTimer);
      }
      channelRuntime?.stop();
      livenessLink?.stop();
      await c7StreamBridge?.stop();
      await buffer.close();
    },
  };
}

/**
 * Активная TCP-проба туннельного IP App-стороны (§5.4) как link edge-клиента.
 * Включается EDGE_VPN_TUNNEL_LIVENESS=on; хост/порт берём из EDGE_VPN_APP_TCP_URL
 * (в туннельном деплое — tcp://10.7.0.1:3049).
 */
function createLivenessLinkFromEnv(env: Record<string, string | undefined>) {
  if ((env.EDGE_VPN_TUNNEL_LIVENESS ?? "off").trim().toLowerCase() !== "on") {
    return null;
  }
  const url = env.EDGE_VPN_APP_TCP_URL;
  if (!url) {
    return null;
  }
  const parsed = new URL(url);
  const probe = createTcpLivenessProbe({
    host: parsed.hostname,
    port: Number(parsed.port || 3049),
    timeoutMs: numberEnv(env.EDGE_VPN_LIVENESS_TIMEOUT_MS, 2_000),
  });
  return createLivenessLink({
    probe,
    intervalMs: numberEnv(env.EDGE_VPN_LIVENESS_INTERVAL_MS, 5_000),
    initialUp: true,
  });
}

export async function startEdgeGatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  const mode = resolveEdgeGatewayMode(env);
  if (mode === "app-vpn") {
    return startAppVpnRuntime(env);
  }

  const runtime = await createEdgeGatewayRuntimeFromEnv(env);
  const port = Number(env.PORT ?? 3000);
  const host = env.HOST ?? "127.0.0.1";
  await listen(runtime.server, port, host);
  const address = runtime.server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  console.log(`edge-gateway ${runtime.mode} listening on http://${host}:${resolvedPort}`);
  return {
    ...runtime,
    close: async () => {
      await closeServer(runtime.server);
      await runtime.close?.();
    },
  };
}

export function createBackendEdgeTunnelHandler({
  backendUrl,
  fetchImpl = fetch,
}: {
  backendUrl: string;
  fetchImpl?: typeof fetch;
}) {
  if (!backendUrl) {
    throw new VpnTunnelError("EDGE_VPN_BACKEND_C9_URL is required for app-vpn mode");
  }

  return async function handle(tunnelMessage) {
    const response = await fetchImpl(backendUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tunnelMessage),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new VpnTunnelError(
        `Backend C9 intake failed with ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  };
}

async function startAppVpnRuntime(env: Record<string, string | undefined>) {
  // Единый слой (Q2): при EDGE_VPN_APP_CRYPTO=off прикладной AES-GCM/mTLS снят.
  const appCrypto = env.EDGE_VPN_APP_CRYPTO !== "off";
  const endpoint = createVpnTunnelAppEndpoint({
    identity: {
      id: env.EDGE_VPN_APP_ID ?? "app-core",
      certificate: appCrypto
        ? requiredEnv(env, "EDGE_VPN_APP_CERT")
        : (env.EDGE_VPN_APP_ID ?? "app-core"),
    },
    trustedCertificates: appCrypto ? parseList(requiredEnv(env, "EDGE_VPN_TRUSTED_EDGE_CERTS")) : [],
    sessionSecret: appCrypto ? resolveVpnSessionSecret(env) : undefined,
    capacity: numberEnv(env.EDGE_VPN_APP_CAPACITY, Number.POSITIVE_INFINITY),
    handle: createBackendEdgeTunnelHandler({
      backendUrl:
        env.EDGE_VPN_BACKEND_C9_URL ??
        "http://backend:3000/internal/edge/tunnel/messages",
    }),
    appCrypto,
  });
  const servers: any[] = [];
  const tcpPort = numberEnv(env.EDGE_VPN_APP_TCP_PORT, 3049);
  const tcpHost = env.EDGE_VPN_APP_TCP_HOST ?? env.HOST ?? "0.0.0.0";
  const tcpServer = createVpnTunnelTcpAppServer({
    endpoint,
    tls: tlsFromEnv(env, "EDGE_VPN_APP_TCP"),
  });
  await listen(tcpServer, tcpPort, tcpHost);
  servers.push(tcpServer);

  const wsPort = numberEnv(env.EDGE_VPN_APP_WSS_PORT ?? env.PORT, 3050);
  const wsHost = env.EDGE_VPN_APP_WSS_HOST ?? env.HOST ?? "0.0.0.0";
  const wsServer = createVpnTunnelWebSocketAppServer({
    endpoint,
    path: env.EDGE_VPN_APP_WSS_PATH ?? "/vpn",
    tls: tlsFromEnv(env, "EDGE_VPN_APP_WSS"),
  });
  await listen(wsServer, wsPort, wsHost);
  servers.push(wsServer);

  console.log(
    `edge-gateway app-vpn listening on tcp://${tcpHost}:${tcpPort} and ws(s)://${wsHost}:${wsPort}${env.EDGE_VPN_APP_WSS_PATH ?? "/vpn"}`,
  );

  return {
    mode: "app-vpn" as const,
    servers,
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}

function createRemoteVpnServerFromEnv(env: Record<string, string | undefined>) {
  const primaryUrl = env.EDGE_VPN_APP_TCP_URL;
  const fallbackUrl = env.EDGE_VPN_APP_WSS_URL;
  if (!primaryUrl && !fallbackUrl) {
    throw new VpnTunnelError("EDGE_VPN_APP_TCP_URL or EDGE_VPN_APP_WSS_URL is required");
  }

  const primary = primaryUrl
    ? createVpnTunnelTcpRemoteServer({
        url: primaryUrl,
        timeoutMs: numberEnv(env.EDGE_VPN_TIMEOUT_MS, 5_000),
        tls: tlsFromEnv(env, "EDGE_VPN_APP_TCP_CLIENT"),
      })
    : null;
  const fallback = fallbackUrl
    ? createVpnTunnelWebSocketRemoteServer({
        url: fallbackUrl,
        timeoutMs: numberEnv(env.EDGE_VPN_TIMEOUT_MS, 5_000),
        tls: tlsFromEnv(env, "EDGE_VPN_APP_WSS_CLIENT"),
      })
    : null;

  if (primary && fallback) {
    return createFailoverVpnTunnelRemoteServer({ primary, fallback });
  }
  return primary ?? fallback;
}

async function createPostgresBufferStore(databaseUrl: string) {
  const { Pool } = await loadPg();
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    store: createPostgresEdgeMessageBufferStore({ client: pool }),
    close: async () => {
      await pool.end();
    },
  };
}

async function createC7StreamClientFromEnv(
  env: Record<string, string | undefined>,
  injectedClient?: any,
) {
  if (injectedClient) {
    return injectedClient;
  }

  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    return null;
  }

  return createRedisStreamClient(redisUrl);
}

async function loadPg() {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  return dynamicImport("pg") as Promise<{ Pool: any }>;
}

function requiredEnv(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  if (!value) {
    throw new VpnTunnelError(`${name} is required`);
  }
  return value;
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBackoff(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * База ядра (App) для прозрачного edge-транзита REST Web Chat (W2). В RF-контуре —
 * адрес ядра, достижимый по сетевому VPN-туннелю (AmneziaWG); в dev — прямой URL
 * бэкенда. Пусто → проброс `/web-chat/*` выключен (маршрут отдаёт 404).
 */
function resolveWebChatBackendUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.EDGE_WEB_CHAT_BACKEND_URL?.trim() || undefined;
}

/**
 * Обязателен ли C7-realtime (Redis) на Edge (W3, WG-8). Включается явным флагом
 * `EDGE_C7_REALTIME_REQUIRED` ЛИБО автоматически при включённом транзите Web Chat
 * (`EDGE_WEB_CHAT_BACKEND_URL`): раз виджет ходит через Edge, ответы менеджера
 * должны доходить по WS — отсутствие Redis тогда fail-fast, а не тихая деградация.
 */
export function isC7RealtimeRequired(env: Record<string, string | undefined>): boolean {
  const flag = (env.EDGE_C7_REALTIME_REQUIRED ?? "").trim().toLowerCase();
  if (flag === "on" || flag === "1" || flag === "true") {
    return true;
  }
  return Boolean(env.EDGE_WEB_CHAT_BACKEND_URL?.trim());
}

function numberEnv(value: string | undefined, fallback: number | undefined) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tlsFromEnv(env: Record<string, string | undefined>, prefix: string) {
  const key = env[`${prefix}_TLS_KEY`];
  const cert = env[`${prefix}_TLS_CERT`];
  const ca = env[`${prefix}_TLS_CA`];
  if (!key && !cert && !ca) {
    return undefined;
  }
  return {
    ...(key ? { key } : {}),
    ...(cert ? { cert } : {}),
    ...(ca ? { ca } : {}),
    rejectUnauthorized: env[`${prefix}_TLS_REJECT_UNAUTHORIZED`] !== "0",
  };
}

function listen(server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
