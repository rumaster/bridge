import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { C6_CAPABILITIES } from "../../packages/contracts/src/c6.js";
import {
  createWebChatAdapter,
  createWebChatCapabilityDescriptor,
} from "../../services/integration-platform/src/adapters/web-chat/web-chat-adapter.js";

const root = process.cwd();
const fixedNow = () => "2026-07-03T09:00:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("INT <-> CORE M0 contracts", () => {
  it("freezes the C2 ingress and egress endpoint names", () => {
    const openApi = readFileSync(
      join(root, "packages/contracts/openapi/c2-internal-api.yaml"),
      "utf8",
    );

    assert.match(openApi, /\/internal\/ingress\/messages:/);
    assert.match(openApi, /\/internal\/egress\/deliveries:/);
    assert.match(openApi, /c2-ingress-message\.schema\.json/);
    assert.match(openApi, /c2-egress-delivery\.schema\.json/);
  });

  it("keeps C6 v1 capability schema aligned with the runtime constant", () => {
    const schema = readJson(
      "packages/contracts/json-schema/c6-capability-descriptor.schema.json",
    );

    assert.deepEqual(
      schema.properties.capabilities.required,
      C6_CAPABILITIES,
    );
  });

  it("publishes a C6 descriptor for Web Chat with only M1-supported capabilities enabled", () => {
    const descriptor = createWebChatCapabilityDescriptor({
      channelId: "channel-web",
      generatedAt: fixedNow(),
    });

    assert.equal(descriptor.contract, "C6.CapabilityDescriptor");
    assert.equal(descriptor.channel_type, "web_chat");
    assert.equal(descriptor.channel_id, "channel-web");
    assert.deepEqual(Object.keys(descriptor.capabilities), C6_CAPABILITIES);
    assert.equal(descriptor.capabilities.text.supported, true);
    assert.equal(descriptor.capabilities.image.supported, true);
    assert.equal(descriptor.capabilities.file.supported, true);
    assert.equal(descriptor.capabilities.typing_indicator.supported, true);
    assert.equal(descriptor.capabilities.read_receipt.supported, true);
    assert.equal(descriptor.capabilities.voice.supported, false);
    assert.equal(descriptor.capabilities.video.supported, false);
    assert.equal(descriptor.capabilities.buttons.supported, false);
  });

  it("captures Web Chat adapter expectations as a C2 Ingress consumer", async () => {
    const calls = [];
    const adapter = createWebChatAdapter({
      coreIngressUrl: "http://core.local/internal/ingress/messages",
      fetchImpl: async (url, init) => {
        calls.push({
          body: JSON.parse(init.body),
          method: init.method,
          url,
        });

        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
      now: fixedNow,
    });

    const result = await adapter.publishIncomingMessage({
      organization_id: "org-1",
      channel_id: "channel-web",
      message_id: "web-msg-contract-1",
      session_id: "session-1",
      sender_ref: "visitor-1",
      text: "contract ping",
    });

    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://core.local/internal/ingress/messages");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.contract, "C2.IngressMessage");
    assert.equal(calls[0].body.version, "1.0.0");
    assert.equal(calls[0].body.idempotency_key, "web-msg-contract-1");
    assert.equal(calls[0].body.message.message_id, "web-msg-contract-1");
    assert.equal(calls[0].body.message.idempotency_key, "web-msg-contract-1");
    assert.equal(calls[0].body.message.channel_type, "web_chat");
    assert.equal(calls[0].body.message.direction, "inbound");
    assert.deepEqual(calls[0].body.message.content, {
      type: "text",
      text: "contract ping",
    });
  });
});
