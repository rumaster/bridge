/**
 * Кадрирование WebSocket (RFC 6455) для боевого C7 WS-канала Edge (этап W3,
 * WG-9, docs/plan/web-chat-channel-production.md).
 *
 * Раньше edge-сервер только КОДИРОВАЛ исходящие текстовые кадры и вовсе не читал
 * входящие (ping/pong/close/subscribe от клиента игнорировались). Здесь —
 * кодировщики управляющих кадров (server→client, немаскированные) и инкрементальный
 * декодер входящих кадров (client→server, маскированные) для keepalive и
 * корректного закрытия.
 */

export const WS_OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export class WebSocketFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketFrameError";
  }
}

/** Кодирует server→client кадр (FIN=1, без маски — RFC 6455 §5.1). */
export function encodeWebSocketFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.byteLength;
  const first = 0x80 | (opcode & 0x0f);
  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([first, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

export function encodeTextFrame(text: string): Buffer {
  return encodeWebSocketFrame(WS_OPCODE.TEXT, Buffer.from(text, "utf8"));
}

export function encodePingFrame(payload: Buffer = Buffer.alloc(0)): Buffer {
  return encodeWebSocketFrame(WS_OPCODE.PING, payload);
}

export function encodePongFrame(payload: Buffer = Buffer.alloc(0)): Buffer {
  return encodeWebSocketFrame(WS_OPCODE.PONG, payload);
}

export function encodeCloseFrame(code = 1000, reason = ""): Buffer {
  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.byteLength);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return encodeWebSocketFrame(WS_OPCODE.CLOSE, payload);
}

export interface WebSocketFrameDecoder {
  /** Скармливает очередной TCP-чанк, возвращает готовые кадры (может быть 0..N). */
  push(chunk: Buffer): WsFrame[];
}

/**
 * Инкрементальный декодер client→server кадров. Клиентские кадры ОБЯЗАНЫ быть
 * маскированы (RFC 6455 §5.3) — снимаем маску. Буферизует неполные кадры между
 * чанками. Бросает {@link WebSocketFrameError} при кадре сверх лимита.
 */
export function createWebSocketFrameDecoder({
  maxFrameBytes = 1024 * 1024,
}: { maxFrameBytes?: number } = {}): WebSocketFrameDecoder {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): WsFrame[] {
      buffer = buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      const frames: WsFrame[] = [];

      for (;;) {
        if (buffer.byteLength < 2) {
          break;
        }

        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.byteLength < offset + 2) {
            break;
          }
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.byteLength < offset + 8) {
            break;
          }
          const big = buffer.readBigUInt64BE(offset);
          if (big > BigInt(maxFrameBytes)) {
            throw new WebSocketFrameError("WebSocket frame exceeds maximum size");
          }
          length = Number(big);
          offset += 8;
        }

        if (length > maxFrameBytes) {
          throw new WebSocketFrameError("WebSocket frame exceeds maximum size");
        }

        let maskKey: Buffer | null = null;
        if (masked) {
          if (buffer.byteLength < offset + 4) {
            break;
          }
          maskKey = buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buffer.byteLength < offset + length) {
          break;
        }

        const raw = buffer.subarray(offset, offset + length);
        let payload: Buffer;
        if (masked && maskKey) {
          payload = Buffer.alloc(length);
          for (let index = 0; index < length; index += 1) {
            payload[index] = raw[index] ^ maskKey[index & 3];
          }
        } else {
          payload = Buffer.from(raw);
        }

        frames.push({ fin, opcode, payload });
        buffer = buffer.subarray(offset + length);
      }

      return frames;
    },
  };
}
