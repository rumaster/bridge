import { createC7RedisStreamBridge } from "./c7-redis-stream-bridge.js";
import { createEdgeCluster } from "./edge-cluster.js";
import { createPostgresEdgeMessageBufferStore } from "./edge-message-buffer.js";
import { createMockWebSocketChannel } from "./mock-ws-channel.js";
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
      server: createEdgeGatewayServer({ now: options.now }),
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
  const sessionSecret = resolveVpnSessionSecret(env);
  const edgeCertificate = requiredEnv(env, "EDGE_VPN_EDGE_CERT");
  const trustedAppCertificates = parseList(requiredEnv(env, "EDGE_VPN_TRUSTED_APP_CERTS"));
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
    });
  const cluster = createEdgeCluster({
    cipher,
    tunnel,
    bufferStore: buffer.store,
    now: options.now,
    bufferTtlMs: numberEnv(env.EDGE_BUFFER_TTL_MS, undefined),
    region: env.EDGE_REGION ?? "RF",
  });
  const wsChannel = options.wsChannel ?? createMockWebSocketChannel();
  const c7StreamClient = await createC7StreamClientFromEnv(env, options.c7StreamClient);
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

  return {
    mode,
    server: createEdgeGatewayServer({
      mode: "production-edge",
      edgeCluster: cluster,
      wsChannel,
      now: options.now,
    }),
    cluster,
    tunnel,
    close: async () => {
      await c7StreamBridge?.stop();
      await buffer.close();
    },
  };
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
  const endpoint = createVpnTunnelAppEndpoint({
    identity: {
      id: env.EDGE_VPN_APP_ID ?? "app-core",
      certificate: requiredEnv(env, "EDGE_VPN_APP_CERT"),
    },
    trustedCertificates: parseList(requiredEnv(env, "EDGE_VPN_TRUSTED_EDGE_CERTS")),
    sessionSecret: resolveVpnSessionSecret(env),
    capacity: numberEnv(env.EDGE_VPN_APP_CAPACITY, Number.POSITIVE_INFINITY),
    handle: createBackendEdgeTunnelHandler({
      backendUrl:
        env.EDGE_VPN_BACKEND_C9_URL ??
        "http://backend:3000/internal/edge/tunnel/messages",
    }),
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
