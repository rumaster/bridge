import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createMockAdapter } from "../../src/adapters/mock/mock-adapter.js";
import { createIntegrationPlatformServer } from "../../src/server.js";

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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("mock adapter <-> mock core smoke", () => {
  const ingressCalls = [];
  let coreServer;
  let coreBaseUrl;
  let integrationServer;
  let integrationBaseUrl;
  let adapter;

  before(async () => {
    coreServer = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/internal/ingress/messages") {
        ingressCalls.push(await readJson(request));
        response.writeHead(202, JSON_HEADERS);
        response.end(JSON.stringify({ accepted: true, sequence: ingressCalls.length }));
        return;
      }

      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    coreBaseUrl = await listen(coreServer);

    adapter = createMockAdapter({
      coreIngressUrl: `${coreBaseUrl}/internal/ingress/messages`,
      now: () => "2026-07-02T16:30:00.000Z",
    });
    integrationServer = createIntegrationPlatformServer({ adapter });
    integrationBaseUrl = await listen(integrationServer);
  });

  after(async () => {
    await close(integrationServer);
    await close(coreServer);
  });

  it("exposes health, metrics, and C6 capabilities for the mock adapter", async () => {
    const healthResponse = await fetch(`${integrationBaseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      status: "ok",
      service: "integration-platform",
      adapter: "mock-adapter",
    });

    const capabilitiesResponse = await fetch(`${integrationBaseUrl}/mock/capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities: any = await capabilitiesResponse.json();
    assert.equal(capabilities.contract, "C6.CapabilityDescriptor");
    assert.equal(capabilities.capabilities.text.supported, true);
    assert.equal(capabilities.capabilities.read_receipt.supported, true);

    const metricsResponse = await fetch(`${integrationBaseUrl}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(
      await metricsResponse.text(),
      /integration_platform_mock_adapter_ingress_published_total 0/,
    );
  });

  it("emulates inbound channel traffic and publishes C2 Ingress to core", async () => {
    const response = await fetch(`${integrationBaseUrl}/mock/incoming/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        organization_id: "org-1",
        channel_id: "channel-mock",
        conversation_ref: "external-conversation-1",
        sender_ref: "external-user-1",
        text: "hello core",
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(ingressCalls.length, 1);
    assert.equal(ingressCalls[0].contract, "C2.IngressMessage");
    assert.equal(ingressCalls[0].message.content.text, "hello core");
    assert.equal(ingressCalls[0].message.direction, "inbound");
  });

  it("accepts C2 Egress from core and stores delivery in the channel stub", async () => {
    const response = await fetch(`${integrationBaseUrl}/internal/egress/deliveries`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C2.EgressDelivery",
        version: "1.0.0",
        idempotency_key: "message-out-1",
        channel_id: "channel-mock",
        message: {
          message_id: "message-out-1",
          organization_id: "org-1",
          channel_id: "channel-mock",
          direction: "outbound",
          content: { type: "text", text: "hello channel" },
        },
      }),
    });

    assert.equal(response.status, 202);
    const body: any = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.delivery.channel_id, "channel-mock");

    assert.deepEqual(adapter.getChannelDeliveries(), [
      {
        idempotency_key: "message-out-1",
        channel_id: "channel-mock",
        message_id: "message-out-1",
        content: { type: "text", text: "hello channel" },
        accepted_at: "2026-07-02T16:30:00.000Z",
      },
    ]);
  });
});
