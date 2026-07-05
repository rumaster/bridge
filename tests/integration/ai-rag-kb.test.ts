import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

import { runMigrations } from "../../scripts/db-migrate.js";
import { formatPgVector } from "../../packages/testing/src/db/factories.js";
import {
  createKnowledgeSearchResponse,
  validateKnowledgeSearchRequest,
} from "../../packages/contracts/src/c3-kb.js";
import { createAiPlatformServer } from "../../services/ai-platform/src/server.js";
import { createRagAssistant } from "../../services/ai-platform/src/rag-assistant.js";
import {
  createDeterministicMockLlm,
  embedText,
} from "../../services/ai-platform/src/llm.js";
import { createBackendKbSearch } from "../../services/ai-platform/src/kb-search.js";

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const TEST_DB = {
  database: "bridge_test",
  user: "bridge_test",
  password: "bridge_test",
};

const ORG_A = "20000000-0000-4000-8000-0000000000a1";
const ORG_B = "20000000-0000-4000-8000-0000000000b1";

const FIXTURES = {
  [ORG_A]: {
    document: "20000000-0000-4000-8000-0000000000a2",
    chunks: [
      {
        id: "20000000-0000-4000-8000-0000000000a3",
        no: 1,
        title: "Политика возврата",
        content: "Для возврата заказа уточните номер заказа и причину возврата товара.",
      },
      {
        id: "20000000-0000-4000-8000-0000000000a4",
        no: 2,
        title: "Сроки доставки",
        content: "Доставка заказа занимает один рабочий день по городу.",
      },
    ],
  },
  [ORG_B]: {
    document: "20000000-0000-4000-8000-0000000000b2",
    chunks: [
      {
        id: "20000000-0000-4000-8000-0000000000b3",
        no: 1,
        title: "Возврат в другой организации",
        content: "Секретная политика возврата заказа и возврата товара организации B.",
      },
    ],
  },
};

function connectionConfig(container, overrides = {}) {
  return {
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    ...TEST_DB,
    ...overrides,
  };
}

async function withClient(config, callback) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function seedTenant(client, organizationId, suffix) {
  const fixture = FIXTURES[organizationId];

  await client.query(
    `INSERT INTO organizations (id, name, timezone, locale, status, created_at, updated_at)
     VALUES ($1, $2, 'UTC', 'ru-RU', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [organizationId, `Organization ${suffix}`],
  );

  await client.query(
    `INSERT INTO knowledge_documents (id, organization_id, title, source, status, indexed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'indexed', '2026-01-01T00:01:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
    [fixture.document, organizationId, `Knowledge ${suffix}`, `manual://kb/${suffix}`],
  );

  for (const chunk of fixture.chunks) {
    await client.query(
      `INSERT INTO knowledge_chunks (id, organization_id, document_id, chunk_no, content, embedding, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, '2026-01-01T00:01:01.000Z')`,
      [
        chunk.id,
        organizationId,
        fixture.document,
        chunk.no,
        chunk.content,
        formatPgVector(embedText(chunk.content)),
        JSON.stringify({ title: chunk.title }),
      ],
    );
  }
}

/**
 * Backend Knowledge Base (C3.kb) stub. It is the ONLY component that touches the
 * database, and it does so under a restricted, RLS-forced role with the tenant
 * context taken from the request — exactly like the real Backend. SVC-AI reaches
 * it over HTTP and never gets a cross-tenant chunk.
 */
function createBackendKbStub({ readConfig }) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.startsWith("/knowledge:search")) {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const validation = validateKnowledgeSearchRequest(payload);
    if (!validation.valid) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: validation.errors }));
      return;
    }

    try {
      const results = await withClient(readConfig, async (client) => {
        // Tenant context drives the RLS policy; no explicit org filter is used,
        // so isolation is proven to be enforced by the database itself.
        await client.query("SELECT set_config('app.current_organization_id', $1, false)", [
          payload.organization_id,
        ]);

        const vector = formatPgVector(payload.embedding);
        const limit = payload.limit ?? 5;
        const rows = await client.query(
          `SELECT kc.id AS chunk_id,
                  kc.document_id,
                  kc.chunk_no,
                  kd.title,
                  kc.content,
                  kc.metadata,
                  (kc.embedding <-> $1::vector) AS distance
             FROM knowledge_chunks kc
             JOIN knowledge_documents kd
               ON kd.id = kc.document_id
             ORDER BY kc.embedding <-> $1::vector
             LIMIT $2`,
          [vector, limit],
        );

        return rows.rows.map((row) => ({
          document_id: row.document_id,
          chunk_id: row.chunk_id,
          chunk_no: row.chunk_no,
          title: row.title,
          content: row.content,
          distance: Number(row.distance),
          metadata: row.metadata,
        }));
      });

      const body = createKnowledgeSearchResponse({
        organizationId: payload.organization_id,
        results,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  return server;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function suggest(baseUrl, organizationId, query) {
  return fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: `req-${organizationId}`,
      organization_id: organizationId,
      query,
    }),
  }).then((response) => response.json());
}

describe("SVC-AI RAG over Backend Knowledge Base (real pgvector)", { timeout: 300_000 }, () => {
  it("answers from the tenant's KB with citations and never leaks other tenants", async () => {
    const container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: TEST_DB.database,
        POSTGRES_USER: TEST_DB.user,
        POSTGRES_PASSWORD: TEST_DB.password,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const roleName = `kb_reader_${process.pid}`;
    const roleIdentifier = quoteIdentifier(roleName);
    let backendStub;
    let aiServer;

    try {
      const adminConfig = connectionConfig(container);
      const readConfig = connectionConfig(container, { user: roleName });

      await withClient(adminConfig, async (client) => {
        await runMigrations({ databaseUrl: adminConfig, direction: "up" });
        await seedTenant(client, ORG_A, "A");
        await seedTenant(client, ORG_B, "B");

        await client.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
        await client.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD 'bridge_test'`);
        await client.query(`GRANT USAGE ON SCHEMA app, public TO ${roleIdentifier}`);
        await client.query(
          `GRANT SELECT ON knowledge_documents, knowledge_chunks TO ${roleIdentifier}`,
        );
      });

      backendStub = createBackendKbStub({ readConfig });
      const backendUrl = await listen(backendStub);

      const llm = createDeterministicMockLlm();
      const kbSearch = createBackendKbSearch({ baseUrl: backendUrl });
      aiServer = createAiPlatformServer({
        ai: createRagAssistant({ llm, kbSearch }),
        mode: "rag",
      });
      const aiUrl = await listen(aiServer);

      // ORG_A asks about returns: the return chunk ranks first, delivery second,
      // and ORG_B's (very similar) return chunk must not appear at all.
      const answerA = await suggest(aiUrl, ORG_A, "Как оформить возврат заказа?");
      assert.equal(answerA.contract, "C4.AssistantSuggestResponse");
      assert.equal(answerA.degraded, false);
      assert.equal(answerA.source_status, "available");

      const chunkIdsA = answerA.sources.map((source) => source.chunk_id);
      assert.equal(chunkIdsA[0], FIXTURES[ORG_A].chunks[0].id, "return chunk ranks first");
      assert.ok(
        chunkIdsA.every((id) => id !== FIXTURES[ORG_B].chunks[0].id),
        "ORG_B chunk must never leak into ORG_A results",
      );
      assert.match(answerA.suggestion.text, /\[1\]/);
      assert.equal(answerA.sources[0].source_type, "knowledge_chunk");

      // ORG_B only ever sees its own chunk.
      const answerB = await suggest(aiUrl, ORG_B, "Как оформить возврат заказа?");
      const chunkIdsB = answerB.sources.map((source) => source.chunk_id);
      assert.deepEqual(chunkIdsB, [FIXTURES[ORG_B].chunks[0].id]);
    } finally {
      if (aiServer) {
        await close(aiServer);
      }
      if (backendStub) {
        await close(backendStub);
      }
      await withClient(connectionConfig(container), async (client) => {
        await client.query(`DROP OWNED BY ${roleIdentifier}`);
        await client.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
      });
      await container.stop();
    }
  });
});
