import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createWebSocketEvent } from "../../../../packages/contracts/src/c7.js";
import { createC7WebSocketChannel } from "../../src/c7-ws-channel.js";
import { createEdgeGatewayServer } from "../../src/server.js";
import { WS_OPCODE, createWebSocketFrameDecoder } from "../../src/ws-frame.js";

/**
 * Боевой C7 WS-транспорт Edge end-to-end (этап W3, WG-9): реальный сокет-клиент
 * получает опубликованное событие текстовым кадром, а сервер декодирует входящие
 * client→server кадры (ping→pong). Изоляция арендаторов — по organization_id.
 */

function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.byteLength;
  const header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | length]);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

interface WsTestClient {
  handshake: string;
  waitForFrame(timeoutMs?: number): Promise<{ opcode: number; payload: Buffer }>;
  sendMasked(opcode: number, payload?: Buffer): void;
  close(): void;
}

function openWsClient(port: number, path: string): Promise<WsTestClient> {
  return new Promise((resolve, reject) => {
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

    const client: WsTestClient = {
      get handshake() {
        return handshake;
      },
      waitForFrame(timeoutMs = 1000) {
        return new Promise((resolveFrame, rejectFrame) => {
          const check = () => consumed < frames.length;
          const done = () => {
            clearTimeout(timer);
            socket.off("data", onData);
            resolveFrame(frames[consumed++]);
          };
          const onData = () => {
            if (check()) {
              done();
            }
          };
          const timer = setTimeout(() => {
            socket.off("data", onData);
            rejectFrame(new Error("timeout waiting for WS frame"));
          }, timeoutMs);
          if (check()) {
            done();
            return;
          }
          socket.on("data", onData);
        });
      },
      sendMasked(opcode, payload = Buffer.alloc(0)) {
        socket.write(maskedClientFrame(opcode, payload));
      },
      close() {
        socket.destroy();
      },
    };

    // Небольшая пауза, чтобы завершился HTTP-апгрейд до первых действий клиента.
    setTimeout(() => resolve(client), 30);
  });
}

describe("Edge C7 WS end-to-end (W3)", () => {
  let server: any;
  let port: number;
  let wsChannel: any;

  // Свежий канал/сервер на каждый тест: eventStore не переносит retained-события
  // между тестами (иначе scoped-реконнект реплеит чужую историю).
  beforeEach(async () => {
    wsChannel = createC7WebSocketChannel();
    server = createEdgeGatewayServer({ wsChannel, now: () => "2026-07-13T09:00:00.000Z" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error: unknown) => (error ? reject(error) : resolve())),
    );
  });

  it("доставляет опубликованное событие подключённому WS-клиенту (scoped)", async () => {
    const client = await openWsClient(
      port,
      "/api/v1/ws?organization_id=org-1&conversation_id=conversation-1",
    );
    assert.match(client.handshake, /^HTTP\/1\.1 101 Switching Protocols/);

    wsChannel.publish(
      createWebSocketEvent({
        event: "message.created",
        eventId: "evt-rt-1",
        organizationId: "org-1",
        payload: { conversation_id: "conversation-1", message_id: "m-1" },
        sequenceNumber: 1,
        occurredAt: "2026-07-13T09:00:01.000Z",
      }),
    );

    const frame = await client.waitForFrame();
    assert.equal(frame.opcode, WS_OPCODE.TEXT);
    const event = JSON.parse(frame.payload.toString("utf8"));
    assert.equal(event.event_id, "evt-rt-1");
    assert.equal(event.organization_id, "org-1");
    client.close();
  });

  it("отвечает pong на client ping (keepalive-декодирование, WG-9)", async () => {
    const client = await openWsClient(port, "/api/v1/ws?organization_id=org-1");
    client.sendMasked(WS_OPCODE.PING, Buffer.from("hb", "utf8"));

    const frame = await client.waitForFrame();
    assert.equal(frame.opcode, WS_OPCODE.PONG);
    assert.equal(frame.payload.toString("utf8"), "hb");
    client.close();
  });

  it("не доставляет событие чужой организации (изоляция арендаторов)", async () => {
    const client = await openWsClient(port, "/api/v1/ws?organization_id=org-1");

    wsChannel.publish(
      createWebSocketEvent({
        event: "message.created",
        eventId: "evt-rt-foreign",
        organizationId: "org-2",
        payload: { conversation_id: "c-x", message_id: "m-x" },
        sequenceNumber: 1,
        occurredAt: "2026-07-13T09:00:02.000Z",
      }),
    );

    await assert.rejects(() => client.waitForFrame(200), /timeout/);
    client.close();
  });
});
