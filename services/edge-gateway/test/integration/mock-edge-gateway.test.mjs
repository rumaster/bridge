import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../../../packages/contracts/src/c9.mjs";
import { createCommunicationCoreMock } from "../../../backend/src/modules/communication-core/mock-ingress-egress.mjs";
import { createEdgeGatewayServer } from "../../src/server.mjs";

const canonicalMessage = Object.freeze({
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  conversation_id: "32345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  channel: "telegram",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 42,
  type: "text",
  content: {
    text: "ping",
  },
  status: "received",
  created_at: "2026-07-02T16:10:00.000Z",
  updated_at: "2026-07-02T16:10:00.000Z",
});

describe("Edge Gateway M0 mock", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createEdgeGatewayServer({
      core: createCommunicationCoreMock({
        clock: () => "2026-07-02T16:10:04.000Z",
      }),
      now: () => "2026-07-02T16:10:03.000Z",
    });
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

  it("starts a mock tunnel and publishes health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const health = await response.json();

    assert.equal(response.status, 200);
    assert.equal(health.service, "edge-gateway");
    assert.deepEqual(health.contracts, ["C7", "C9"]);
  });

  it("accepts C9 tunnel messages and forwards their C1 payload to Core mock", async () => {
    const tunnelMessage = createEdgeTunnelMessage({
      payload: canonicalMessage,
      receivedAt: "2026-07-02T16:10:01.000Z",
      bufferedAt: "2026-07-02T16:10:02.000Z",
      forwardedAt: "2026-07-02T16:10:03.000Z",
    });

    const response = await fetch(`${baseUrl}/api/v1/internal/edge/tunnel/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(tunnelMessage),
    });
    const ack = await response.json();

    assert.equal(response.status, 202);
    assert.equal(ack.contract, "C9.EdgeTunnelAck");
    assert.equal(ack.accepted, true);
    assert.equal(ack.idempotency_key, canonicalMessage.idempotency_key);
  });

  it("starts a mock WebSocket channel at GET /ws", async () => {
    const response = await fetch(`${baseUrl}/api/v1/ws`);
    const body = await response.json();

    assert.equal(response.status, 426);
    assert.equal(body.contract, "C7");
    assert.equal(body.path, "/ws");
    assert.equal(body.reconnect.resume_cursor, "last_event_id");
  });

  it("handles a minimal WebSocket upgrade for the mock channel", async () => {
    const address = server.address();
    const handshake = await requestWebSocketUpgrade(address.port, "/api/v1/ws");

    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(handshake, /Sec-WebSocket-Accept:/);
  });
});

function requestWebSocketUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    let handshake = "";
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "\r\n",
        ].join("\r\n"),
      );
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      handshake += chunk;
      socket.end();
      socket.destroy();
    });
    socket.once("close", () => resolve(handshake));
    socket.once("error", reject);
  });
}
