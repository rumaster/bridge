import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  WS_OPCODE,
  WebSocketFrameError,
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
} from "../../src/ws-frame.js";

/** Маскирует payload как клиентский кадр (RFC 6455 §5.3) для проверки декодера. */
function encodeMaskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.byteLength;
  let header: Buffer;
  const first = 0x80 | (opcode & 0x0f);

  if (length < 126) {
    header = Buffer.from([first, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

describe("ws-frame — кодирование server→client", () => {
  it("кодирует текстовый кадр с FIN=1 и без маски", () => {
    const frame = encodeTextFrame("hello");
    assert.equal(frame[0], 0x81); // FIN + opcode text
    assert.equal(frame[1] & 0x80, 0); // не маскирован
    assert.equal(frame[1] & 0x7f, 5);
    assert.equal(frame.subarray(2).toString("utf8"), "hello");
  });

  it("кодирует ping/pong/close управляющие кадры", () => {
    assert.equal(encodePingFrame()[0], 0x89);
    assert.equal(encodePongFrame()[0], 0x8a);
    const close = encodeCloseFrame(1000, "bye");
    assert.equal(close[0], 0x88);
    assert.equal(close.readUInt16BE(2), 1000);
  });

  it("использует 16-битную длину для payload ≥ 126 байт", () => {
    const frame = encodeTextFrame("x".repeat(200));
    assert.equal(frame[1] & 0x7f, 126);
    assert.equal(frame.readUInt16BE(2), 200);
  });
});

describe("ws-frame — декодирование client→server (маскированных)", () => {
  it("снимает маску и возвращает текст, ping, close", () => {
    const decoder = createWebSocketFrameDecoder();
    const frames = decoder.push(
      Buffer.concat([
        encodeMaskedClientFrame(WS_OPCODE.TEXT, Buffer.from('{"type":"subscribe"}', "utf8")),
        encodeMaskedClientFrame(WS_OPCODE.PING, Buffer.from("hb", "utf8")),
        encodeMaskedClientFrame(WS_OPCODE.CLOSE, Buffer.alloc(0)),
      ]),
    );

    assert.equal(frames.length, 3);
    assert.equal(frames[0].opcode, WS_OPCODE.TEXT);
    assert.equal(frames[0].payload.toString("utf8"), '{"type":"subscribe"}');
    assert.equal(frames[1].opcode, WS_OPCODE.PING);
    assert.equal(frames[1].payload.toString("utf8"), "hb");
    assert.equal(frames[2].opcode, WS_OPCODE.CLOSE);
  });

  it("собирает кадр, пришедший несколькими TCP-чанками", () => {
    const decoder = createWebSocketFrameDecoder();
    const full = encodeMaskedClientFrame(WS_OPCODE.TEXT, Buffer.from("split-payload", "utf8"));

    const firstHalf = decoder.push(full.subarray(0, 3));
    assert.deepEqual(firstHalf, []); // кадр ещё не полон
    const rest = decoder.push(full.subarray(3));
    assert.equal(rest.length, 1);
    assert.equal(rest[0].payload.toString("utf8"), "split-payload");
  });

  it("бросает WebSocketFrameError на кадре сверх лимита", () => {
    const decoder = createWebSocketFrameDecoder({ maxFrameBytes: 8 });
    assert.throws(
      () => decoder.push(encodeMaskedClientFrame(WS_OPCODE.TEXT, Buffer.from("0123456789"))),
      WebSocketFrameError,
    );
  });
});
