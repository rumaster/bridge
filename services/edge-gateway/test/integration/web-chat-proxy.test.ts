import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createEdgeGatewayServer } from "../../src/server.js";

/**
 * Прозрачный edge-транзит REST Web Chat «клиент → edge → app» (этап W2,
 * WG-3/WG-4, docs/plan/web-chat-channel-production.md). Edge синхронно проксирует
 * `/api/v1/web-chat/*` в ядро (здесь — ядро-дублёр) поверх сетевого VPN-туннеля и
 * зеркалит ответ; idempotency-key, тело и статус сохраняются, контракты не меняются.
 */

function listen(server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
}

describe("Edge Web Chat REST-транзит (W2)", () => {
  const received = [];
  let coreServer;
  let coreBaseUrl;
  let edgeServer;
  let edgeBaseUrl;

  before(async () => {
    // Ядро-дублёр: фиксирует полученный запрос и отвечает как WebChatService.
    coreServer = createServer(async (request, response) => {
      const body = await readBody(request);
      received.push({
        method: request.method,
        url: request.url,
        idempotencyKey: request.headers["idempotency-key"] ?? null,
        edgeTunnel: request.headers["x-bridge-edge-tunnel"] ?? null,
        contentType: request.headers["content-type"] ?? null,
        body,
      });
      if (request.url === "/api/v1/web-chat/sessions") {
        response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ conversationId: "conv-1", endpointId: "ep-1" }));
        return;
      }
      if (request.url?.startsWith("/api/v1/web-chat/conversations/")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ items: [], page: { limit: 20, total: 0 } }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ code: "RESOURCE_NOT_FOUND" }));
    });
    coreBaseUrl = await listen(coreServer);

    edgeServer = createEdgeGatewayServer({
      now: () => "2026-07-13T09:00:00.000Z",
      webChatBackendUrl: coreBaseUrl,
    });
    edgeBaseUrl = await listen(edgeServer);
  });

  after(async () => {
    await close(edgeServer);
    await close(coreServer);
  });

  it("проксирует POST /web-chat/sessions в ядро и зеркалит ответ (клиент→edge→app)", async () => {
    const response = await fetch(`${edgeBaseUrl}/api/v1/web-chat/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-1",
        "x-bridge-edge-tunnel": "web_chat",
      },
      body: JSON.stringify({ organization_id: "org-1", visitor_session_id: "v-1" }),
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(payload, { conversationId: "conv-1", endpointId: "ep-1" });

    const last = received.at(-1);
    assert.equal(last.method, "POST");
    assert.equal(last.url, "/api/v1/web-chat/sessions");
    // Сквозные заголовки сохранены: идемпотентность и маркер C9-туннеля.
    assert.equal(last.idempotencyKey, "idem-1");
    assert.equal(last.edgeTunnel, "web_chat");
    assert.equal(JSON.parse(last.body).organization_id, "org-1");
  });

  it("проксирует GET истории с query, сохраняя путь и параметры", async () => {
    const response = await fetch(
      `${edgeBaseUrl}/api/v1/web-chat/conversations/conv-1/messages?limit=20&organization_id=org-1`,
    );

    assert.equal(response.status, 200);
    const last = received.at(-1);
    assert.equal(last.method, "GET");
    assert.equal(
      last.url,
      "/api/v1/web-chat/conversations/conv-1/messages?limit=20&organization_id=org-1",
    );
    assert.equal(last.body, "");
  });

  it("сохраняет idempotency-key при повторной отправке (дедуп — на ядре)", async () => {
    const send = () =>
      fetch(`${edgeBaseUrl}/api/v1/web-chat/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "idem-dup" },
        body: JSON.stringify({ organization_id: "org-1", body: { type: "text", text: "hi" } }),
      });

    await send();
    await send();

    const lastTwo = received.slice(-2);
    assert.equal(lastTwo.length, 2);
    assert.ok(lastTwo.every((entry) => entry.idempotencyKey === "idem-dup"));
    assert.ok(lastTwo.every((entry) => entry.url === "/api/v1/web-chat/messages"));
  });
});

describe("Edge Web Chat REST-транзит выключен без backend URL", () => {
  let edgeServer;
  let edgeBaseUrl;

  before(async () => {
    edgeServer = createEdgeGatewayServer({ now: () => "2026-07-13T09:00:00.000Z" });
    edgeBaseUrl = await listen(edgeServer);
  });

  after(async () => {
    await close(edgeServer);
  });

  it("без webChatBackendUrl путь /web-chat/* отдаёт прежний 404", async () => {
    const response = await fetch(`${edgeBaseUrl}/api/v1/web-chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: "org-1" }),
    });

    assert.equal(response.status, 404);
  });
});
