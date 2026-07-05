import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createBroadcastCoreDeliveryDraft,
  validateBroadcastCoreDeliveryDraft,
} from "../../packages/contracts/src/c8.js";
import { createBroadcastPlatformServer } from "../../services/broadcast-platform/src/server.js";

const root = process.cwd();
const fixedNow = () => "2026-07-02T16:30:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("BCAST <-> CORE M0 C8 contract", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createBroadcastPlatformServer({ now: fixedNow });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("publishes frozen C8 OpenAPI operations", () => {
    const openApi = readJson("packages/contracts/openapi/broadcasts/c8.broadcasts.openapi.json");

    assert.equal(openApi.openapi, "3.1.0");
    assert.equal(openApi["x-contract-id"], "C8");
    assert.equal(openApi["x-owner"], "SVC-BCAST");
    assert.equal(openApi.info.version, "1.0.0");
    assert.deepEqual(openApi.servers, [{ url: "/api/v1" }]);
    assert.ok(openApi.paths["/broadcasts"].get);
    assert.ok(openApi.paths["/broadcasts"].post);
    assert.ok(openApi.paths["/broadcasts/{id}:start"].post);
    assert.ok(openApi.paths["/broadcasts/{id}/stats"].get);
  });

  it("freezes the BCAST -> CORE delivery draft through C1/C2", () => {
    const draft = createBroadcastCoreDeliveryDraft({
      broadcastId: "broadcast-1",
      organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      endpointId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      channel: "web_chat",
      text: "Здравствуйте",
      createdAt: fixedNow(),
    });
    const validation = validateBroadcastCoreDeliveryDraft(draft);

    assert.equal(validation.valid, true);
    assert.equal(draft.delivery_path, "C1/C2");
    assert.equal(draft.message.sender_type, "broadcast");
    assert.equal(draft.message.direction, "outbound");
    assert.equal(draft.message.status, "routed");
    assert.equal(draft.message.idempotency_key, draft.message.id);
  });

  it("smokes C8 start and emits a valid CORE delivery draft", async () => {
    const startResponse = await fetch(`${baseUrl}/api/v1/broadcasts/broadcast-1:start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract: "C8.StartBroadcastRequest",
        version: "1.0.0",
        request_id: "req-broadcast-core-contract-1",
        organization_id: "org-1",
        started_by: "manager-1",
        mode: "immediate",
      }),
    });
    const started = await startResponse.json();

    assert.equal(startResponse.status, 200);
    assert.equal(started.core_delivery_draft.delivery_path, "C1/C2");

    assert.equal(validateBroadcastCoreDeliveryDraft(started.core_delivery_draft).valid, true);
  });
});
