import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { Pool } from "pg";
import { GenericContainer, Wait } from "testcontainers";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const DB = {
  database: "bridge_backend_dist_e2e",
  password: "bridge_backend_dist_e2e",
  user: "bridge_backend_dist_e2e",
};

const ORG = "21000000-0000-4000-8000-000000000101";
const CLIENT = "21000000-0000-4000-8000-000000000301";
const ENDPOINT = "21000000-0000-4000-8000-000000000401";
const CONVERSATION = "21000000-0000-4000-8000-000000000501";
const EDGE_CLIENT = "21000000-0000-4000-8000-000000000302";
const EDGE_ENDPOINT = "21000000-0000-4000-8000-000000000402";
const EDGE_CONVERSATION = "21000000-0000-4000-8000-000000000502";
const EDGE_MESSAGE = "21000000-0000-4000-8000-000000000601";
const BROADCAST_ID = "21000000-0000-4000-8000-000000000701";
const BROADCAST_MESSAGE = "21000000-0000-4000-8000-000000000602";
const PUBLIC_INGRESS_MESSAGE = "21000000-0000-4000-8000-000000000603";
const PUBLIC_OUTBOUND_MESSAGE = "21000000-0000-4000-8000-000000000604";
const MANAGER_USER = "21000000-0000-4000-8000-000000000201";
const MANAGER_SESSION = "21000000-0000-4000-8000-000000000901";
const MANAGER_TOKEN = "brs_backend_dist_manager";
const AUTH_HASH_SECRET = "backend-dist-e2e-secret";
const MANAGER_ROLE = "21000000-0000-4000-8000-000000000801";

test(
  "dist/main.js handles M4/M5 internal communication-core paths",
  { timeout: 180_000 },
  async () => {
    execFileSync("npm", ["run", "build", "--workspace", "@bridge/backend"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: DB.database,
        POSTGRES_PASSWORD: DB.password,
        POSTGRES_USER: DB.user,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 1))
      .start();
    const databaseUrl = connectionString(container);
    let backend;
    let egressServer;
    const egressDeliveries = [];

    try {
      runRootScript("scripts/db-migrate.ts", ["up"], databaseUrl);
      await seedFixtures(databaseUrl);

      egressServer = createHttpServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/internal/delivery/dispatch") {
          response.statusCode = 404;
          response.end();
          return;
        }

        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        egressDeliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true, duplicate: false }));
      });
      const egressBaseUrl = await listenHttp(egressServer);

      const port = await getAvailablePort();
      backend = spawn(process.execPath, ["services/backend/dist/main.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUTH_HASH_SECRET,
          DATABASE_URL: databaseUrl,
          INTEGRATION_EGRESS_URL: `${egressBaseUrl}/internal/delivery/dispatch`,
          PORT: String(port),
          TELEGRAM_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
          TELEGRAM_LOGIN_START_RATE_LIMIT: "2",
          TELEGRAM_LOGIN_VERIFY_RATE_LIMIT: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      backend.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      backend.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      await waitForHttp(`http://127.0.0.1:${port}/health`, backend, () => output);

      const publicIngress = await postJson(
        `http://127.0.0.1:${port}/internal/ingress/messages`,
        publicIngressEnvelope(),
      );
      assert.equal(publicIngress.status, 202);
      assert.equal(publicIngress.body.status, "routed");
      assert.equal(publicIngress.body.conversation_id, CONVERSATION);

      const conversations = await getJson(
        `http://127.0.0.1:${port}/api/v1/conversations`,
        authHeaders(),
      );
      assert.equal(conversations.status, 200);
      assert.equal(conversations.body.items.some((item) => item.id === CONVERSATION), true);

      const messages = await getJson(
        `http://127.0.0.1:${port}/api/v1/conversations/${CONVERSATION}/messages`,
        authHeaders(),
      );
      assert.equal(messages.status, 200);
      assert.equal(messages.body.items.some((item) => item.id === PUBLIC_INGRESS_MESSAGE), true);

      // После Fix 1 (#256) POST /api/v1/messages не просто сохраняет ответ
      // менеджера как `routed`, но и сам инициирует egress-доставку во внешний
      // канал: статус переходит routed→sent, а C2.EgressDelivery идемпотентно
      // уходит в integration-platform (INTEGRATION_EGRESS_URL). Отдельный вызов
      // /internal/egress/messages на уже доставленном сообщении теперь был бы
      // недопустимым переходом sent→sent; этот эндпоинт покрыт integration-тестом
      // internal-messaging.spec.ts, а здесь проверяем сквозную авто-доставку
      // ответа через dist/main.js.
      const outbound = await postJson(
        `http://127.0.0.1:${port}/api/v1/messages`,
        {
          id: PUBLIC_OUTBOUND_MESSAGE,
          conversationId: CONVERSATION,
          endpointId: ENDPOINT,
          content: { text: "dist manager reply" },
        },
        authHeaders({ "idempotency-key": PUBLIC_OUTBOUND_MESSAGE }),
      );
      assert.equal(outbound.status, 201);
      assert.equal(outbound.body.id, PUBLIC_OUTBOUND_MESSAGE);
      assert.equal(outbound.body.status, "sent");
      assert.equal(egressDeliveries.length, 1);
      assert.equal(egressDeliveries[0].contract, "C2.EgressDelivery");
      assert.equal(egressDeliveries[0].message.message_id, PUBLIC_OUTBOUND_MESSAGE);

      const edge = await postJson(
        `http://127.0.0.1:${port}/internal/edge/tunnel/messages`,
        edgeTunnelMessage(),
      );
      assert.equal(edge.status, 202);
      assert.equal(edge.body.contract, "C9.EdgeTunnelAck");
      assert.equal(edge.body.message_id, EDGE_MESSAGE);
      assert.equal(edge.body.core_status, "routed");

      const broadcast = await postJson(
        `http://127.0.0.1:${port}/internal/broadcast/deliveries`,
        broadcastDeliveryDraft(),
      );
      assert.equal(broadcast.status, 202);
      assert.equal(broadcast.body.message_id, BROADCAST_MESSAGE);
      assert.equal(broadcast.body.status, "sent");
      assert.equal(broadcast.body.broadcast_message_status, "sent");

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(metrics.status, 200);
      assert.match(
        await metrics.text(),
        /bridge_backend_communication_core_ingress_total\{result="all"\}/,
      );

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const start = await postJson(
          `http://127.0.0.1:${port}/api/v1/auth/login/telegram/start`,
          { telegramUsername: "dist_manager" },
        );
        assert.equal(start.status, 202);
      }
      const limitedStart = await postJson(
        `http://127.0.0.1:${port}/api/v1/auth/login/telegram/start`,
        { telegramUsername: "dist_manager" },
      );
      assert.equal(limitedStart.status, 429);
      assert.equal(limitedStart.body.code, "TOO_MANY_REQUESTS");

      const missingRequestId = "21000000-0000-4000-8000-000000000999";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const verify = await postJson(
          `http://127.0.0.1:${port}/api/v1/auth/login/telegram/verify`,
          { code: "000000", requestId: missingRequestId },
        );
        assert.equal(verify.status, 401);
      }
      const limitedVerify = await postJson(
        `http://127.0.0.1:${port}/api/v1/auth/login/telegram/verify`,
        { code: "000000", requestId: missingRequestId },
      );
      assert.equal(limitedVerify.status, 429);
      assert.equal(limitedVerify.body.code, "TOO_MANY_REQUESTS");
    } finally {
      if (backend) {
        await stopProcess(backend);
      }
      if (egressServer) {
        await closeHttp(egressServer);
      }
      await container.stop();
    }
  },
);

function publicIngressEnvelope() {
  return {
    contract: "C2.IngressMessage",
    version: "1.0.0",
    idempotency_key: PUBLIC_INGRESS_MESSAGE,
    received_at: "2026-07-04T09:59:59.000Z",
    message: {
      message_id: PUBLIC_INGRESS_MESSAGE,
      organization_id: ORG,
      channel_id: "dist-bot",
      channel_type: "telegram",
      external_message_id: "dist-public-ingress-1",
      conversation_ref: "dist-room",
      sender_ref: "client-1",
      direction: "inbound",
      content: { type: "text", text: "dist public ingress" },
      occurred_at: "2026-07-04T09:59:59.000Z",
    },
  };
}

function edgeTunnelMessage() {
  return {
    contract: "C9.EdgeTunnelMessage",
    version: "1.0.0",
    endpoint_id: EDGE_ENDPOINT,
    sequence_number: 1,
    idempotency_key: EDGE_MESSAGE,
    payload: {
      id: EDGE_MESSAGE,
      idempotency_key: EDGE_MESSAGE,
      organization_id: ORG,
      conversation_id: EDGE_CONVERSATION,
      client_id: EDGE_CLIENT,
      endpoint_id: EDGE_ENDPOINT,
      channel: "telegram",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 1,
      type: "text",
      content: { text: "dist edge message" },
      status: "received",
      created_at: "2026-07-04T10:00:00.000Z",
      metadata: {
        channel_id: "dist-edge",
        conversation_ref: "dist-edge-room",
        external_id: "dist-edge:client-1",
        sender_ref: "client-1",
      },
    },
  };
}

function broadcastDeliveryDraft() {
  return {
    contract: "C8.BroadcastCoreDeliveryDraft",
    version: "1.0.0",
    broadcast_id: BROADCAST_ID,
    organization_id: ORG,
    delivery_path: "C1/C2",
    core_contracts: ["C1", "C2"],
    sender_type: "broadcast",
    broadcast_name: "Dist broadcast",
    message: {
      id: BROADCAST_MESSAGE,
      idempotency_key: BROADCAST_MESSAGE,
      organization_id: ORG,
      conversation_id: CONVERSATION,
      endpoint_id: ENDPOINT,
      channel: "telegram",
      direction: "outbound",
      sender_type: "broadcast",
      sequence_number: 1,
      type: "text",
      content: { text: "dist broadcast message" },
      status: "routed",
      created_at: "2026-07-04T10:01:00.000Z",
    },
  };
}

function connectionString(container) {
  return `postgres://${DB.user}:${DB.password}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB.database}`;
}

function runRootScript(scriptPath, args, databaseUrl) {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      execFileSync("node", ["--import", "tsx", scriptPath, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      });
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  throw lastError;
}

async function seedFixtures(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.is_platform_operator', 'true', false)");
    await client.query(
      `
        INSERT INTO roles (id, code, scope, description)
        VALUES ($1, 'manager', 'organization', 'Dist e2e manager')
        ON CONFLICT (code) DO UPDATE SET id = EXCLUDED.id, scope = EXCLUDED.scope
      `,
      [MANAGER_ROLE],
    );
    await client.query(
      `
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Dist tenant', 'dist e2e fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG],
    );
    await client.query(
      `
        INSERT INTO users (
          id, organization_id, telegram_username, telegram_id, email, display_name, status
        )
        VALUES ($1, $2, 'dist_manager', '555000222', NULL, 'Dist Manager', 'active')
      `,
      [MANAGER_USER, ORG],
    );
    await client.query(
      `
        INSERT INTO user_roles (user_id, role_id, organization_id)
        VALUES ($1, $2, $3)
      `,
      [MANAGER_USER, MANAGER_ROLE, ORG],
    );
    await client.query(
      `
        INSERT INTO auth_sessions (
          id, user_id, organization_id, token_hash, issued_at, expires_at
        )
        VALUES ($1, $2, $3, $4, '2026-07-04T09:00:00.000Z', '2030-07-04T17:00:00.000Z')
      `,
      [MANAGER_SESSION, MANAGER_USER, ORG, hashSessionToken(MANAGER_TOKEN)],
    );
    await client.query(
      "INSERT INTO clients (id, organization_id, display_name) VALUES ($1, $2, 'Dist Client')",
      [CLIENT, ORG],
    );
    await client.query(
      `
        INSERT INTO communication_endpoints (
          id, organization_id, client_id, channel, external_id, verified, verified_at, metadata
        )
        VALUES ($1, $2, $3, 'telegram', 'dist-bot:client-1', true, '2026-01-01T00:00:00.000Z',
          '{"channel_id":"dist-bot","conversation_ref":"dist-room"}'::jsonb)
      `,
      [ENDPOINT, ORG, CLIENT],
    );
    await client.query(
      `
        INSERT INTO conversations (id, organization_id, client_id, status, last_message_at, created_at, updated_at)
        VALUES ($1, $2, $3, 'open', '2026-07-04T09:00:00.000Z', '2026-07-04T09:00:00.000Z', '2026-07-04T09:00:00.000Z')
      `,
      [CONVERSATION, ORG, CLIENT],
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function getAvailablePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return port;
}

async function listenHttp(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForHttp(url, child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend dist server exited before readiness. Output:\n${getOutput()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }

  throw new Error(`Backend dist server did not become ready. Output:\n${getOutput()}`);
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });

  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${MANAGER_TOKEN}`,
    "x-organization-id": ORG,
    ...extra,
  };
}

function hashSessionToken(token) {
  return `sha256:${createHmac("sha256", AUTH_HASH_SECRET)
    .update(`auth_session:server:${token}`)
    .digest("hex")}`;
}

async function stopProcess(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}
