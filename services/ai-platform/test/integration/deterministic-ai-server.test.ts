import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createAiPlatformServer } from "../../src/server.js";

const JSON_HEADERS = { "content-type": "application/json" };

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("AI Platform deterministic mock server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createAiPlatformServer({
      now: () => "2026-07-02T16:30:00.000Z",
    });
    baseUrl = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  it("starts and exposes health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "ai-platform",
      mode: "deterministic-mock",
      contract: "C4",
    });
  });

  it("serves deterministic assistant suggestions over C4", async () => {
    const payload = {
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
      request_id: "req-assistant-1",
      organization_id: "org-1",
      query: "Как оформить возврат?",
      context: { messages: [] },
    };

    const first = await fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const second = await fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await first.json(), await second.json());
  });

  it("serves deterministic onboarding commands over C4", async () => {
    const response = await fetch(`${baseUrl}/api/v1/ai/onboarding:command`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C4.OnboardingCommandRequest",
        version: "1.0.0",
        request_id: "req-onboarding-1",
        organization_id: "org-1",
        actor_user_id: "admin-1",
        prompt: "Подключи Telegram канал",
        context: {},
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.command.action, "channel.connect");
    assert.equal(body.command.params.channel_type, "telegram");
  });

  it("returns controlled validation errors for invalid DTOs", async () => {
    const response = await fetch(`${baseUrl}/api/v1/ai/assistant:suggest`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C4.AssistantSuggestRequest",
        version: "1.0.0",
        request_id: "req-assistant-1",
        query: "",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.title, "Validation failed");
    assert.equal(body.status, 400);
  });
});
