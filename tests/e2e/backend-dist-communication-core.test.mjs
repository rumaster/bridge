import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
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

    try {
      runRootScript("scripts/db-migrate.mjs", ["up"], databaseUrl);
      await seedFixtures(databaseUrl);

      const port = await getAvailablePort();
      backend = spawn(process.execPath, ["services/backend/dist/main.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          PORT: String(port),
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
    } finally {
      if (backend) {
        await stopProcess(backend);
      }
      await container.stop();
    }
  },
);

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
      execFileSync("node", [scriptPath, ...args], {
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
        INSERT INTO organizations (id, name, description, timezone, locale, status)
        VALUES ($1, 'Dist tenant', 'dist e2e fixture', 'UTC', 'ru-RU', 'active')
      `,
      [ORG],
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
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return port;
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
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
