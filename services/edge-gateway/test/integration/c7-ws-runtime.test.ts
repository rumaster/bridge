import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createC7WsRuntime } from "../../src/c7-ws-runtime.js";
import { WS_OPCODE, createWebSocketFrameDecoder } from "../../src/ws-frame.js";

/**
 * Standalone C7 WS-рантайм App-стороны end-to-end (docs/plan/manager-realtime-messages):
 * инъектируем fake Redis-стрим-клиент, отдающий одно C7-событие, и проверяем весь
 * путь Redis→WS мост → C7-канал → WS-сервер → сокет-клиент с фильтром по
 * organization_id (изоляция арендаторов). Плюс контракт независимости групп Redis:
 * группа по умолчанию — manager-c7 (НЕ edge-gateway-c7).
 */

interface StreamEntry {
  id: string;
  event: Record<string, unknown>;
}

function createFakeStreamClient(entries: StreamEntry[]) {
  const pending = [...entries];
  const acked: string[] = [];
  let observedGroup: string | null = null;

  return {
    observedGroup: () => observedGroup,
    acked: () => acked,
    async ensureConsumerGroup(_stream: string, group: string) {
      observedGroup = group;
    },
    async readGroup({ stream, group }: { stream: string; group: string }) {
      observedGroup = group;
      const next = pending.shift();
      if (!next) {
        // RESP2-форма пустого ответа XREADGROUP.
        return [] as unknown;
      }
      // RESP2: [[streamName, [[id, [field, value, ...]]]]].
      return [[stream, [[next.id, ["event", JSON.stringify(next.event)]]]]] as unknown;
    },
    async ack(_stream: string, _group: string, id: string) {
      acked.push(id);
    },
    async close() {},
  };
}

interface WsTestClient {
  handshake: string;
  waitForFrame(timeoutMs?: number): Promise<{ opcode: number; payload: Buffer }>;
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
      close() {
        socket.destroy();
      },
    };

    setTimeout(() => resolve(client), 30);
  });
}

function messageCreatedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "message.created",
    event_id: "message.created:msg-1",
    organization_id: "00000000-0000-4000-8000-000000000101",
    sequence_number: 1,
    payload: { message: { id: "msg-1", conversationId: "conv-1" } },
    occurred_at: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("App-side C7 WS runtime", () => {
  let runtime: Awaited<ReturnType<typeof createC7WsRuntime>>;
  let port: number;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      if (runtime.server.listening) {
        await new Promise<void>((resolve, reject) =>
          runtime.server.close((error: unknown) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  it("uses the manager-c7 consumer group by default (independent from edge-gateway-c7)", async () => {
    const streamClient = createFakeStreamClient([]);
    runtime = await createC7WsRuntime({
      env: { C7_REALTIME_POLL_MS: "10" },
      streamClient,
    });
    assert.equal(runtime.group, "manager-c7");
  });

  it("honours C7_REALTIME_GROUP override", async () => {
    runtime = await createC7WsRuntime({
      env: { C7_REALTIME_GROUP: "manager-c7-custom" },
      streamClient: createFakeStreamClient([]),
    });
    assert.equal(runtime.group, "manager-c7-custom");
  });

  it("fans a stream event out to a WS client scoped to the same organization", async () => {
    const streamClient = createFakeStreamClient([
      { id: "1-0", event: messageCreatedEvent() },
    ]);
    runtime = await createC7WsRuntime({
      env: { C7_REALTIME_POLL_MS: "10" },
      streamClient,
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    port = (runtime.server.address() as { port: number }).port;

    const client = await openWsClient(
      port,
      "/api/v1/ws?organization_id=00000000-0000-4000-8000-000000000101",
    );
    assert.match(client.handshake, /^HTTP\/1\.1 101 Switching Protocols/);

    runtime.start();

    const frame = await client.waitForFrame();
    assert.equal(frame.opcode, WS_OPCODE.TEXT);
    const event = JSON.parse(frame.payload.toString("utf8"));
    assert.equal(event.event_id, "message.created:msg-1");
    assert.equal(event.organization_id, "00000000-0000-4000-8000-000000000101");
    assert.equal(runtime.group, "manager-c7");
    client.close();
  });

  it("does not deliver events from a different organization (tenant isolation)", async () => {
    const streamClient = createFakeStreamClient([
      {
        id: "1-0",
        event: messageCreatedEvent({
          event_id: "message.created:foreign",
          organization_id: "00000000-0000-4000-8000-000000000999",
        }),
      },
    ]);
    runtime = await createC7WsRuntime({
      env: { C7_REALTIME_POLL_MS: "10" },
      streamClient,
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    port = (runtime.server.address() as { port: number }).port;

    const client = await openWsClient(
      port,
      "/api/v1/ws?organization_id=00000000-0000-4000-8000-000000000101",
    );
    runtime.start();

    await assert.rejects(() => client.waitForFrame(200), /timeout/);
    client.close();
  });
});
