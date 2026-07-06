import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { connect as connectTls, createServer as createTlsServer } from "node:tls";

import {
  VpnTunnelAuthError,
  VpnTunnelBackpressureError,
  VpnTunnelChannelDownError,
  VpnTunnelError,
} from "./vpn-tunnel.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface VpnTunnelRpcEndpoint {
  handshake: (hello: any) => any;
  deliver: (args: any) => any;
}

export interface CreateVpnTunnelTcpAppServerOptions {
  endpoint: VpnTunnelRpcEndpoint;
  tls?: Record<string, any>;
  maxFrameBytes?: number;
}

export interface CreateVpnTunnelTcpRemoteServerOptions {
  url?: string;
  host?: string;
  port?: number;
  tls?: Record<string, any> | boolean;
  timeoutMs?: number;
}

export interface CreateVpnTunnelWebSocketAppServerOptions {
  endpoint: VpnTunnelRpcEndpoint;
  path?: string;
  tls?: Record<string, any>;
  healthPath?: string;
  maxFrameBytes?: number;
}

export interface CreateVpnTunnelWebSocketRemoteServerOptions {
  url: string;
  timeoutMs?: number;
  tls?: Record<string, any>;
}

export interface CreateFailoverVpnTunnelRemoteServerOptions {
  primary: VpnTunnelRpcEndpoint & { getMetrics?: () => Record<string, unknown> };
  fallback: VpnTunnelRpcEndpoint & { getMetrics?: () => Record<string, unknown> };
}

export function createVpnTunnelTcpAppServer({
  endpoint,
  tls,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
}: CreateVpnTunnelTcpAppServerOptions) {
  if (!endpoint) {
    throw new VpnTunnelError("endpoint is required for VPN TCP app server");
  }

  const onConnection = (socket) => {
    let buffer = "";
    let completed = false;

    socket.on("data", async (chunk) => {
      if (completed) {
        return;
      }
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes) {
        completed = true;
        writeTcpResponse(socket, {
          ok: false,
          error: serializeError(new VpnTunnelError("VPN TCP frame is too large")),
        });
        return;
      }

      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }

      completed = true;
      const line = buffer.slice(0, lineEnd);
      try {
        const request = JSON.parse(line);
        const payload = await dispatchRpc(endpoint, request);
        writeTcpResponse(socket, { ok: true, payload: encodeBuffers(payload) });
      } catch (error) {
        writeTcpResponse(socket, { ok: false, error: serializeError(error) });
      }
    });
  };

  return tls ? createTlsServer(tls, onConnection) : createTcpServer(onConnection);
}

export function createVpnTunnelTcpRemoteServer({
  url,
  host,
  port,
  tls,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CreateVpnTunnelTcpRemoteServerOptions = {}) {
  const target = resolveTcpTarget({ url, host, port, tls });
  const metrics = {
    tcp_request_total: 0,
    tcp_error_total: 0,
  };

  async function call(type: string, payload: any) {
    metrics.tcp_request_total += 1;
    try {
      return await sendTcpRpc({ ...target, timeoutMs }, { type, payload: encodeBuffers(payload) });
    } catch (error) {
      metrics.tcp_error_total += 1;
      throw error;
    }
  }

  return {
    handshake(clientHello) {
      return call("handshake", clientHello);
    },
    deliver(args) {
      return call("deliver", args);
    },
    getMetrics() {
      return { ...metrics };
    },
  };
}

export function createVpnTunnelWebSocketAppServer({
  endpoint,
  path = "/vpn",
  tls,
  healthPath = "/health",
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
}: CreateVpnTunnelWebSocketAppServerOptions) {
  if (!endpoint) {
    throw new VpnTunnelError("endpoint is required for VPN WebSocket app server");
  }

  const requestHandler = (request, response) => {
    const url = new URL(request.url ?? "/", "http://vpn-app.local");
    if (request.method === "GET" && url.pathname === healthPath) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", service: "edge-vpn-app", mode: "app-vpn" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: 404, title: "Not Found" }));
  };
  const server = tls ? createHttpsServer(tls, requestHandler) : createHttpServer(requestHandler);

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", "http://vpn-app.local");
    if (url.pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.trim() === "") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n",
      ].join("\r\n"),
    );

    let buffered = Buffer.alloc(0);
    let completed = false;
    socket.on("data", async (chunk) => {
      if (completed) {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > maxFrameBytes) {
        completed = true;
        writeWebSocketRpcResponse(socket, {
          ok: false,
          error: serializeError(new VpnTunnelError("VPN WebSocket frame is too large")),
        });
        return;
      }

      const frame = decodeWebSocketTextFrame(buffered);
      if (!frame) {
        return;
      }

      completed = true;
      try {
        const request = JSON.parse(frame.text);
        const payload = await dispatchRpc(endpoint, request);
        writeWebSocketRpcResponse(socket, { ok: true, payload: encodeBuffers(payload) });
      } catch (error) {
        writeWebSocketRpcResponse(socket, { ok: false, error: serializeError(error) });
      }
    });
  });

  return server;
}

export function createVpnTunnelWebSocketRemoteServer({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tls,
}: CreateVpnTunnelWebSocketRemoteServerOptions) {
  const metrics = {
    websocket_request_total: 0,
    websocket_error_total: 0,
  };

  async function call(type: string, payload: any) {
    metrics.websocket_request_total += 1;
    try {
      return await sendWebSocketRpc({ url, timeoutMs, tls }, { type, payload: encodeBuffers(payload) });
    } catch (error) {
      metrics.websocket_error_total += 1;
      throw error;
    }
  }

  return {
    handshake(clientHello) {
      return call("handshake", clientHello);
    },
    deliver(args) {
      return call("deliver", args);
    },
    getMetrics() {
      return { ...metrics };
    },
  };
}

export function createFailoverVpnTunnelRemoteServer({
  primary,
  fallback,
}: CreateFailoverVpnTunnelRemoteServerOptions) {
  const metrics = {
    primary_total: 0,
    fallback_total: 0,
    failed_total: 0,
  };

  async function call(method: "handshake" | "deliver", payload: any) {
    metrics.primary_total += 1;
    try {
      return await primary[method](payload);
    } catch (error) {
      if (error instanceof VpnTunnelAuthError || error instanceof VpnTunnelBackpressureError) {
        metrics.failed_total += 1;
        throw error;
      }
      metrics.fallback_total += 1;
      return fallback[method](payload);
    }
  }

  return {
    handshake(clientHello) {
      return call("handshake", clientHello);
    },
    deliver(args) {
      return call("deliver", args);
    },
    getMetrics() {
      return { ...metrics };
    },
  };
}

async function dispatchRpc(endpoint: VpnTunnelRpcEndpoint, request: any) {
  if (!request || typeof request !== "object") {
    throw new VpnTunnelError("VPN RPC request must be an object");
  }
  const payload = decodeBuffers(request.payload);
  if (request.type === "handshake") {
    return endpoint.handshake(payload);
  }
  if (request.type === "deliver") {
    return endpoint.deliver(payload);
  }
  throw new VpnTunnelError(`Unsupported VPN RPC method: ${request.type}`);
}

function writeTcpResponse(socket, response: any) {
  socket.end(`${JSON.stringify(response)}\n`);
}

function writeWebSocketRpcResponse(socket, response: any) {
  socket.write(encodeWebSocketTextFrame(JSON.stringify(response), { masked: false }));
  socket.end();
}

async function sendTcpRpc(
  target: { host: string; port: number; tls: any; timeoutMs: number },
  request: any,
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = target.tls
      ? connectTls({ host: target.host, port: target.port, ...target.tls })
      : connectTcp({ host: target.host, port: target.port });

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(toChannelDown(error));
    }

    socket.setTimeout(target.timeoutMs, () => fail(new Error("VPN TCP RPC timed out")));
    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      response += chunk;
      const lineEnd = response.indexOf("\n");
      if (lineEnd === -1 || settled) {
        return;
      }
      settled = true;
      socket.end();
      try {
        resolve(readRpcResponse(response.slice(0, lineEnd)));
      } catch (error) {
        reject(error);
      }
    });
    const sendRequest = () => socket.write(`${JSON.stringify(request)}\n`);
    if (target.tls) {
      socket.once("secureConnect", sendRequest);
    } else {
      socket.once("connect", sendRequest);
    }
  });
}

async function sendWebSocketRpc(
  target: { url: string; timeoutMs: number; tls?: Record<string, any> },
  request: any,
) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target.url);
    const secure = parsed.protocol === "wss:";
    if (!secure && parsed.protocol !== "ws:") {
      reject(new VpnTunnelError(`Unsupported VPN WebSocket protocol: ${parsed.protocol}`));
      return;
    }

    const port = Number(parsed.port || (secure ? 443 : 80));
    const host = parsed.hostname;
    const key = randomBytes(16).toString("base64");
    const path = `${parsed.pathname || "/"}${parsed.search}`;
    const socket = secure
      ? connectTls({ host, port, servername: host, ...target.tls })
      : connectTcp({ host, port });

    let settled = false;
    let upgraded = false;
    let buffer = Buffer.alloc(0);

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(toChannelDown(error));
    }

    function sendUpgrade() {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "\r\n",
        ].join("\r\n"),
      );
    }

    socket.setTimeout(target.timeoutMs, () => fail(new Error("VPN WebSocket RPC timed out")));
    socket.once("error", fail);
    socket.once("connect", () => {
      if (!secure) {
        sendUpgrade();
      }
    });
    socket.once("secureConnect", sendUpgrade);
    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const headers = buffer.subarray(0, headerEnd).toString("utf8");
        if (!headers.startsWith("HTTP/1.1 101")) {
          fail(new Error(`VPN WebSocket upgrade failed: ${headers.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(encodeWebSocketTextFrame(JSON.stringify(request), { masked: true }));
      }

      const frame = decodeWebSocketTextFrame(buffer);
      if (!frame) {
        return;
      }
      settled = true;
      socket.end();
      try {
        resolve(readRpcResponse(frame.text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readRpcResponse(line: string) {
  const response = JSON.parse(line);
  if (response.ok === true) {
    return decodeBuffers(response.payload);
  }
  throw deserializeError(response.error);
}

function resolveTcpTarget({ url, host, port, tls }: CreateVpnTunnelTcpRemoteServerOptions) {
  if (url) {
    const parsed = new URL(url);
    const isTls = parsed.protocol === "tls:" || parsed.protocol === "tcps:";
    if (!isTls && parsed.protocol !== "tcp:") {
      throw new VpnTunnelError(`Unsupported VPN TCP protocol: ${parsed.protocol}`);
    }
    return {
      host: parsed.hostname,
      port: Number(parsed.port),
      tls: isTls ? normalizeTlsOptions(tls ?? true) : false,
    };
  }

  if (!host || !port) {
    throw new VpnTunnelError("VPN TCP remote requires url or {host, port}");
  }
  return {
    host,
    port,
    tls: normalizeTlsOptions(tls),
  };
}

function normalizeTlsOptions(tls: Record<string, any> | boolean | undefined) {
  if (tls === true) {
    return {};
  }
  if (!tls) {
    return false;
  }
  return tls;
}

function encodeBuffers(value: any): any {
  if (Buffer.isBuffer(value)) {
    return { __bridge_buffer_base64: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map(encodeBuffers);
  }
  if (value && typeof value === "object") {
    const encoded = {};
    for (const [key, nested] of Object.entries(value)) {
      encoded[key] = encodeBuffers(nested);
    }
    return encoded;
  }
  return value;
}

function decodeBuffers(value: any): any {
  if (Array.isArray(value)) {
    return value.map(decodeBuffers);
  }
  if (value && typeof value === "object") {
    if (
      Object.keys(value).length === 1 &&
      typeof value.__bridge_buffer_base64 === "string"
    ) {
      return Buffer.from(value.__bridge_buffer_base64, "base64");
    }
    const decoded = {};
    for (const [key, nested] of Object.entries(value)) {
      decoded[key] = decodeBuffers(nested);
    }
    return decoded;
  }
  return value;
}

function serializeError(error: any) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function deserializeError(error: any) {
  const message = error?.message ?? "VPN transport RPC failed";
  switch (error?.name) {
    case "VpnTunnelAuthError":
      return new VpnTunnelAuthError(message);
    case "VpnTunnelBackpressureError":
      return new VpnTunnelBackpressureError(message);
    case "VpnTunnelChannelDownError":
      return new VpnTunnelChannelDownError(message);
    case "VpnTunnelError":
      return new VpnTunnelError(message);
    default:
      return new VpnTunnelError(message);
  }
}

function toChannelDown(error: any) {
  if (error instanceof VpnTunnelError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VpnTunnelChannelDownError(`VPN transport is unavailable: ${message}`);
}

function encodeWebSocketTextFrame(text: string, { masked = false } = {}) {
  const payload = Buffer.from(text, "utf8");
  let headerLength = 2;
  if (payload.byteLength >= 126 && payload.byteLength <= 0xffff) {
    headerLength += 2;
  } else if (payload.byteLength > 0xffff) {
    headerLength += 8;
  }
  const maskLength = masked ? 4 : 0;
  const frame = Buffer.alloc(headerLength + maskLength + payload.byteLength);
  frame[0] = 0x81;

  let offset = 2;
  const maskBit = masked ? 0x80 : 0;
  if (payload.byteLength < 126) {
    frame[1] = maskBit | payload.byteLength;
  } else if (payload.byteLength <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(payload.byteLength, offset);
    offset += 2;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), offset);
    offset += 8;
  }

  if (!masked) {
    payload.copy(frame, offset);
    return frame;
  }

  const mask = randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function decodeWebSocketTextFrame(buffer: Buffer) {
  if (buffer.byteLength < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) {
    throw new VpnTunnelChannelDownError("VPN WebSocket closed");
  }
  if (opcode !== 0x1) {
    throw new VpnTunnelError(`Unsupported VPN WebSocket opcode: ${opcode}`);
  }

  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.byteLength < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VpnTunnelError("VPN WebSocket frame is too large");
    }
    length = Number(bigLength);
    offset += 8;
  }

  let mask: Buffer | null = null;
  if (masked) {
    if (buffer.byteLength < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.byteLength < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    text: payload.toString("utf8"),
    bytesRead: offset + length,
  };
}
