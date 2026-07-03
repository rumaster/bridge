import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../packages/contracts/src/c4.mjs";
import { createAiPlatformServer } from "../../services/ai-platform/src/server.mjs";
import { createRagAssistant } from "../../services/ai-platform/src/rag-assistant.mjs";
import { createDeterministicMockLlm } from "../../services/ai-platform/src/llm.mjs";
import { createInMemoryKbSearch } from "../../services/ai-platform/src/kb-search.mjs";
import { createOnboardingCommander } from "../../services/ai-platform/src/onboarding.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const ORG_A = "10000000-0000-4000-8000-0000000000a1";
const ORG_B = "10000000-0000-4000-8000-0000000000b1";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * A minimal Backend that exposes `POST /onboarding:apply` over HTTP. It is the
 * single sanctioned write path (ТЗ §12.6, §13.13): it re-validates the §12.6
 * command produced by SVC-AI, enforces tenant match and administrator rights,
 * and only then mutates its in-memory configuration store. AI never touches the
 * store directly — it merely describes the command (ТЗ §12.10). The production
 * NestJS applier with a real DB and audit is covered by
 * `services/backend/test/integration/m3-facades.spec.ts`.
 */
function createBackendApplyServer(store) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.startsWith("/onboarding:apply")) {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const { command, organization_id: organizationId, roles } = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    );

    const validation = validateAiOnboardingCommand(command);
    if (!validation.valid) {
      response.writeHead(422, JSON_HEADERS);
      response.end(JSON.stringify({ status: "rejected", reason: "COMMAND_INVALID" }));
      return;
    }

    if (command.organization_id !== organizationId) {
      response.writeHead(403, JSON_HEADERS);
      response.end(JSON.stringify({ status: "rejected", reason: "COMMAND_ORG_MISMATCH" }));
      return;
    }

    if (command.action !== "noop" && !(roles ?? []).includes("administrator")) {
      response.writeHead(403, JSON_HEADERS);
      response.end(JSON.stringify({ status: "rejected", reason: "ROLE_FORBIDDEN" }));
      return;
    }

    if (command.action === "configuration.upsert") {
      const { key, value } = command.params;
      store.set(`${organizationId}:${key}`, value);
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ status: "applied", action: command.action, key, value }));
      return;
    }

    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify({ status: "noop", action: command.action }));
  });
}

describe("E2E — AI Onboarding применяет конфиг (CP-5)", () => {
  const llm = createDeterministicMockLlm();
  const store = new Map();
  let backendServer;
  let aiServer;
  let aiUrl;

  before(async () => {
    backendServer = createBackendApplyServer(store);
    await listen(backendServer);

    aiServer = createAiPlatformServer({
      ai: createRagAssistant({
        llm,
        kbSearch: createInMemoryKbSearch({ chunks: [], llm }),
        onboarding: createOnboardingCommander({ llm, now: () => "2026-07-03T10:00:00.000Z" }),
      }),
      mode: "rag",
    });
    aiUrl = await listen(aiServer);
  });

  after(async () => {
    await close(aiServer);
    await close(backendServer);
  });

  async function interpret(organizationId, prompt) {
    const response = await fetch(`${aiUrl}/api/v1/ai/onboarding:command`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C4.OnboardingCommandRequest",
        version: "1.0.0",
        request_id: `req-${organizationId}`,
        organization_id: organizationId,
        actor_user_id: "admin-1",
        prompt,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  async function apply(backendUrl, organizationId, command, roles) {
    const response = await fetch(`${backendUrl}/onboarding:apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ command, organization_id: organizationId, roles }),
    });
    return { status: response.status, body: await response.json() };
  }

  it("превращает NL-запрос администратора в команду и применяет её через Backend", async () => {
    const backendUrl = `http://${backendServer.address().address}:${backendServer.address().port}`;

    // 1. NL → §12.6 команда на стороне SVC-AI (без доступа к данным).
    const interpreted = await interpret(ORG_A, "Установи часовой пояс Europe/Moscow");
    assert.equal(interpreted.contract, "C4.OnboardingCommandResponse");
    assert.equal(interpreted.degraded, false);
    assert.equal(interpreted.command.action, "configuration.upsert");
    assert.equal(interpreted.command.organization_id, ORG_A);

    // 2. Backend валидирует и применяет — единственный санкционированный путь записи.
    const applied = await apply(backendUrl, ORG_A, interpreted.command, ["administrator"]);
    assert.equal(applied.status, 200);
    assert.equal(applied.body.status, "applied");
    assert.equal(applied.body.key, "organization.timezone");

    // 3. Конфигурация изменилась именно в арендаторе ORG_A.
    assert.equal(store.get(`${ORG_A}:organization.timezone`), "Europe/Moscow");
  });

  it("сохраняет изоляцию арендатора: команду ORG_A нельзя применить в контексте ORG_B", async () => {
    const backendUrl = `http://${backendServer.address().address}:${backendServer.address().port}`;

    const interpreted = await interpret(ORG_A, "Установи часовой пояс Europe/Moscow");
    const rejected = await apply(backendUrl, ORG_B, interpreted.command, ["administrator"]);

    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.reason, "COMMAND_ORG_MISMATCH");
    assert.equal(store.get(`${ORG_B}:organization.timezone`), undefined);
  });
});
