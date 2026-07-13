import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createWebSocketEvent } from "../../../../packages/contracts/src/c7.js";
import { createC7RedisStreamBridge } from "../../src/c7-redis-stream-bridge.js";
import { createC7WebSocketChannel } from "../../src/c7-ws-channel.js";
import { createEdgeGatewayServer } from "../../src/server.js";
import { WS_OPCODE, createWebSocketFrameDecoder } from "../../src/ws-frame.js";

/**
 * Сквозная приёмка «Web Chat: приём и ответ» через Edge (этап W7, CP-1/CP-7,
 * docs/plan/web-chat-channel-production.md). Реальные компоненты Edge (REST-транзит
 * server.ts + C7 Redis→WS мост + боевой WS-канал), замоканы только границы:
 * ядро (App) — HTTP-дублёр, Redis-поток — управляемый fake-клиент.
 *
 * Проверяет: приём (виджет → edge → app по REST), ответ (менеджер → app публикует
 * C7 → Redis → мост → edge WS → виджет), изоляцию арендаторов по WS и дедуп по
 * event_id. По образцу m6-cp-max: «реальные компоненты под тестом, замоканные края».
 */

const ORG_A = "22345678-1234-4234-8234-123456789abc";
const CONV_A = "32345678-1234-4234-8234-123456789abc";
const ORG_B = "42345678-1234-4234-8234-123456789abc";

// --- Fake App (ядро): фиксирует REST Web Chat и отвечает как WebChatService. ---
function createFakeCore() {
  const received: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    received.push({ method: request.method, url: request.url, body });

    if (request.url === "/api/v1/web-chat/sessions") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ conversationId: CONV_A, endpointId: "ep-a", organizationId: ORG_A }));
      return;
    }
    if (request.url === "/api/v1/web-chat/messages") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: JSON.parse(body || "{}").idempotency_key, status: "received" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  return { server, received };
}

// --- Fake Redis Stream: управляемая очередь C7-событий для моста. ---
function createFakeStreamClient() {
  const queue: Array<[string, string[]]> = [];
  let seq = 0;
  return {
    push(event: unknown) {
      seq += 1;
      queue.push([`${seq}-0`, ["event", JSON.stringify(event), "type", "message.created"]]);
    },
    async ensureConsumerGroup() {
      return "OK";
    },
    async readGroup({ stream }: { stream: string }) {
      if (queue.length === 0) {
        return [];
      }
      const entries = queue.splice(0, queue.length);
      return [[stream, entries]];
    },
    async ack() {
      return 1;
    },
    async close() {
      return undefined;
    },
  };
}

function messageCreatedEvent(input: {
  eventId: string;
  organizationId: string;
  conversationId: string;
  sequenceNumber: number;
  senderType: "client" | "manager";
  text: string;
}) {
  return createWebSocketEvent({
    event: "message.created",
    eventId: input.eventId,
    organizationId: input.organizationId,
    sequenceNumber: input.sequenceNumber,
    payload: {
      message: {
        id: input.eventId,
        conversation_id: input.conversationId,
        organization_id: input.organizationId,
        channel: "web_chat",
        sender_type: input.senderType,
        content: { text: input.text },
        sequence_number: input.sequenceNumber,
      },
    },
    occurredAt: "2026-07-13T10:00:00.000Z",
  });
}

// --- Минимальный WS-клиент поверх сырого сокета (декодирует кадры сервера). ---
function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | payload.byteLength]);
  const masked = Buffer.alloc(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i += 1) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

function openWsClient(port: number, path: string) {
  return new Promise<{
    handshake: string;
    waitEvent(timeoutMs?: number): Promise<any>;
    ping(): void;
    close(): void;
  }>((resolve, reject) => {
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
    const decoder = createWebSocketFrameDecoder();
    const frames: Array<{ opcode: number; payload: Buffer }> = [];
    let consumed = 0;
    let handshake = "";
    let upgraded = false;
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary === -1) {
          return;
        }
        handshake = buffer.subarray(0, boundary).toString("utf8");
        upgraded = true;
        buffer = buffer.subarray(boundary + 4);
      }
      if (buffer.byteLength > 0) {
        for (const frame of decoder.push(buffer)) {
          frames.push(frame);
        }
        buffer = Buffer.alloc(0);
      }
    });
    socket.once("error", reject);

    setTimeout(
      () =>
        resolve({
          get handshake() {
            return handshake;
          },
          waitEvent(timeoutMs = 1000) {
            return new Promise<any>((res, rej) => {
              const tick = () => {
                while (consumed < frames.length) {
                  const frame = frames[consumed++];
                  if (frame.opcode === WS_OPCODE.TEXT) {
                    clearTimeout(timer);
                    socket.off("data", onData);
                    res(JSON.parse(frame.payload.toString("utf8")));
                    return true;
                  }
                }
                return false;
              };
              const onData = () => tick();
              const timer = setTimeout(() => {
                socket.off("data", onData);
                rej(new Error("timeout waiting for WS event"));
              }, timeoutMs);
              if (!tick()) {
                socket.on("data", onData);
              }
            });
          },
          ping() {
            socket.write(maskedClientFrame(WS_OPCODE.PING, Buffer.from("hb")));
          },
          close() {
            socket.destroy();
          },
        }),
      30,
    );
  });
}

function listen(server: any): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server: any): Promise<void> {
  return new Promise((resolve, reject) => server.close((e: unknown) => (e ? reject(e) : resolve())));
}

describe("W7 — сквозная приёмка «Web Chat: приём и ответ» через Edge", () => {
  // Свежие компоненты на каждый тест: eventStore WS-канала не переносит
  // retained-события между тестами (иначе scoped-реконнект реплеит чужую историю).
  let core: ReturnType<typeof createFakeCore>;
  let stream: ReturnType<typeof createFakeStreamClient>;
  let wsChannel: ReturnType<typeof createC7WebSocketChannel>;
  let bridge: ReturnType<typeof createC7RedisStreamBridge>;
  let edgeServer: any;
  let edgePort: number;

  beforeEach(async () => {
    core = createFakeCore();
    stream = createFakeStreamClient();
    wsChannel = createC7WebSocketChannel();
    const corePort = await listen(core.server);
    bridge = createC7RedisStreamBridge({ streamClient: stream as never, wsChannel });
    edgeServer = createEdgeGatewayServer({
      webChatBackendUrl: `http://127.0.0.1:${corePort}`,
      wsChannel,
      now: () => "2026-07-13T10:00:00.000Z",
    });
    edgePort = await listen(edgeServer);
  });

  afterEach(async () => {
    await close(edgeServer);
    await close(core.server);
    await bridge.stop();
  });

  it("проводит весь путь: приём по REST через Edge + ответ менеджера по C7/WS", async () => {
    // 1. Посетитель открывает сессию — REST идёт «клиент → edge → app».
    const sessionResponse = await fetch(`http://127.0.0.1:${edgePort}/api/v1/web-chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://shop.test" },
      body: JSON.stringify({ organization_id: ORG_A, visitor_session_id: "v-1" }),
    });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json()) as { conversationId: string };
    assert.equal(session.conversationId, CONV_A);
    // Edge реально доставил запрос в ядро с сохранением пути и Origin.
    assert.equal(core.received.at(-1).url, "/api/v1/web-chat/sessions");

    // 2. Посетитель подписывается на свой поток по WS (scoped по org+conversation).
    const visitor = await openWsClient(
      edgePort,
      `/api/v1/ws?organization_id=${ORG_A}&conversation_id=${CONV_A}`,
    );
    assert.match(visitor.handshake, /^HTTP\/1\.1 101 Switching Protocols/);

    // 3. Посетитель отправляет реплику — REST через Edge в ядро.
    const send = await fetch(`http://127.0.0.1:${edgePort}/api/v1/web-chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m-1" },
      body: JSON.stringify({ organization_id: ORG_A, conversation_id: CONV_A, idempotency_key: "m-1" }),
    });
    assert.equal(send.status, 201);

    // 4. Ответ менеджера: ядро публикует C7 message.created → Redis → мост → WS.
    stream.push(
      messageCreatedEvent({
        eventId: "evt-manager-1",
        organizationId: ORG_A,
        conversationId: CONV_A,
        sequenceNumber: 2,
        senderType: "manager",
        text: "Здравствуйте, чем помочь?",
      }),
    );
    await bridge.pollOnce();

    const managerEvent = await visitor.waitEvent();
    assert.equal(managerEvent.event, "message.created");
    assert.equal(managerEvent.event_id, "evt-manager-1");
    assert.equal(managerEvent.organization_id, ORG_A);
    assert.equal(managerEvent.payload.message.sender_type, "manager");

    visitor.close();
  });

  it("изоляция арендаторов: событие ORG_B не доходит до подписчика ORG_A", async () => {
    const visitorA = await openWsClient(edgePort, `/api/v1/ws?organization_id=${ORG_A}&conversation_id=${CONV_A}`);

    stream.push(
      messageCreatedEvent({
        eventId: "evt-foreign-1",
        organizationId: ORG_B,
        conversationId: "conv-b",
        sequenceNumber: 1,
        senderType: "manager",
        text: "чужой поток",
      }),
    );
    await bridge.pollOnce();

    await assert.rejects(() => visitorA.waitEvent(200), /timeout/);
    visitorA.close();
  });

  it("дедуп по event_id: повтор одного события доставляется один раз", async () => {
    const visitor = await openWsClient(edgePort, `/api/v1/ws?organization_id=${ORG_A}&conversation_id=${CONV_A}`);
    const event = messageCreatedEvent({
      eventId: "evt-dup-1",
      organizationId: ORG_A,
      conversationId: CONV_A,
      sequenceNumber: 5,
      senderType: "manager",
      text: "однократно",
    });

    stream.push(event);
    stream.push(event); // тот же event_id (повтор публикации)
    await bridge.pollOnce();

    const first = await visitor.waitEvent();
    assert.equal(first.event_id, "evt-dup-1");
    // Повтор с тем же event_id отбрасывается каналом (дедуп) — второго события нет.
    await assert.rejects(() => visitor.waitEvent(200), /timeout/);
    visitor.close();
  });
});
