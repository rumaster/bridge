import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { validateAiOnboardingCommand } from "../../../../packages/contracts/src/c4.js";
import { createDeterministicMockLlm } from "../../src/llm.js";
import { createOnboardingCommander } from "../../src/onboarding.js";
import { createRagAssistant } from "../../src/rag-assistant.js";
import { createInMemoryKbSearch } from "../../src/kb-search.js";
import { createAiPlatformServer } from "../../src/server.js";

const JSON_HEADERS = { "content-type": "application/json" };
const ORG = "org-onboarding-server";

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

describe("AI Platform onboarding server (mock LLM commander)", () => {
  let server;
  let baseUrl;

  before(async () => {
    const llm = createDeterministicMockLlm();
    const ai = createRagAssistant({
      llm,
      kbSearch: createInMemoryKbSearch({ chunks: [], llm }),
      onboarding: createOnboardingCommander({ llm, now: () => "2026-07-03T10:00:00.000Z" }),
    });
    server = createAiPlatformServer({ ai, mode: "rag" });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  async function command(prompt, organizationId = ORG) {
    const response = await fetch(`${baseUrl}/api/v1/ai/onboarding:command`, {
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
    return response;
  }

  it("serves a valid §12.6 command interpreted from a NL request", async () => {
    const response = await command("Установи часовой пояс Europe/Moscow");
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.contract, "C4.OnboardingCommandResponse");
    assert.equal(body.command.action, "configuration.upsert");
    assert.equal(body.command.organization_id, ORG);
    assert.equal(validateAiOnboardingCommand(body.command).valid, true);
  });

  it("connects a Telegram channel from a NL request", async () => {
    const response = await command("Подключи Telegram канал");
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.command.action, "channel.connect");
    assert.equal(body.command.params.channel_type, "telegram");
  });

  it("returns controlled validation errors for a malformed request", async () => {
    const response = await command("");
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.title, "Validation failed");
  });
});
