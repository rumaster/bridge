import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../../../packages/contracts/src/c9.js";
import {
  createFailoverVpnTunnelRemoteServer,
  createVpnTunnelTcpAppServer,
  createVpnTunnelTcpRemoteServer,
  createVpnTunnelWebSocketAppServer,
  createVpnTunnelWebSocketRemoteServer,
} from "../../src/vpn-transport.js";
import {
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
} from "../../src/vpn-tunnel.js";

const ENDPOINT_ID = "42345678-1234-4234-8234-123456789abc";
const ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
const CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";
const SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCnleucyrH0DRWD
jNrp/vS/K/9rEwsuOUdj+jj++2QjNWUZYggrw4xoZDC/WzJJ/a+2coIv9qWZ9fn6
sdDIgLX+N+uUfdN1HP8uOLfk9LMvnhX7qX7gMMkLPTbHoNpFzsq6vrdS/ctopRla
QF7a82O1K/5tKVlAPrgx8CyEKhGnRIFvmSTBqk838S02EJW/GH0OAEgC+ypqPIK7
tKGs8xbo8vQ+SI41EmQYN8vL9c7ZY9dN0P3h+wk8XxLiBTNmbKRBOokxeD7/bQCY
/5e3Qk4cRvG4Uch/qx0pW5wJf5l4uP1QDXXuyZOZXjh9H6eF9czEgFO/vJ5WK2Y4
/l5e3GyDAgMBAAECggEAQDSPftQnhoWGww4xhunPsfh01HyI0Y5PXC3vLT16OYUI
9UcaM04pmoscJAwYAcIIUmGfoCmie5CCU/pRL6gkUb/x6UOlwp434+kGB1l61xj9
ehwPiGwYck5jEOt/BLS79f0AdnLWvgJW6r1zufX6stwmj4MCdzswTa2jGIWXmtnk
7H8RVmSzvXMyI3ECN7RwzAGPmSLwFvU+rmO+iJ1J19qPaWi0Thb5US/9etk5qu/f
gdqZN7Q/dtEcI0HvOUmHzfcdXhirzY6u/FnVyasZiy72IOJ1R88rffBsOtf8jThc
6GlwcvOLtPmjihg6QU5kbYTnlJ7VpLbbp/9SfArlrQKBgQDUUycZqkoZoHp4FMUf
HL2cr2Ii0+S9pFgyD/1MF8qTuQtM9Tb8J70L/wtohJjaC9QAi2wBBjVOgcVUFWPp
SFY4f61UDyDEVGt6YMbmaNdhXIDwgS5KMZTiecRzwQpi6jyFT/Jn0xcy+wAezeUR
OsZvRm728owQDi+pCkGRbKWk5wKBgQDKDtbe7HjBFp7jWeEzoXIp3HHo8LmUgHcw
Rwn6C/DIbM4a9N72M7J3zOVWRpYNY2x3HvNPOhQNK8xSYQsytLEHQbAAk/fFzu+Y
OZbqS6FaR3f5Npo8i3iJ5+CA/Qr0PccLVNBD/mzCXCchOho6MKYp6G/LZlC/BX8x
sivP5OOsBQKBgQCqI8fdRRwD1RjOSLZ86+b1O4UEK4/Md3lFBJMQ+q+WGF352TWq
cZ2Hk2Rs6HQjpf7IQPDXEUZ+FnctncZmFVUiCQ23oje7m3pUomBAGhsdJacdEicp
xPltUe4eY74S7Wh520p/8CNS8tdx18OLPvHsESCyOkIKS5PdfR51jf5eWQKBgQCm
yLj0KZ1DRLjCUV5ij9D8XMppzMpimefIIdtKWrDVv3ohJh8kemfGG4ryPDF/u6G8
cf/EVdxXQt/U3+WuZRf7NW1iDMFotfdvX5oCq4r0Sintu/R0JWvJ6WyXDEgOcy/p
WojOlySPCiICe0NK5P1DemlNK5dbFd531unzIKwNQQKBgFCIVaRopYJnxgQ6zUSe
DzIqYnOOcSP1Coh84SBhdOq36KMkdhOzxp2ItMvvl9acTXmfZgxMlT+VCssK0tsi
Wr/0cEEGv3IhjgMSAm/s+fFFYpAX06LnsjtZ2BkZQ9tmJWuI12Zlxfgw9xfS0Bs9
r/hxXr18HhJLgpIMEfnj02XU
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUGqUQqOKRGOb+wDA/cTmLYP7v+dIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcwNjE0MTkxM1oXDTI3MDcw
NjE0MTkxM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAp5XrnMqx9A0Vg4za6f70vyv/axMLLjlHY/o4/vtkIzVl
GWIIK8OMaGQwv1sySf2vtnKCL/almfX5+rHQyIC1/jfrlH3TdRz/Lji35PSzL54V
+6l+4DDJCz02x6DaRc7Kur63Uv3LaKUZWkBe2vNjtSv+bSlZQD64MfAshCoRp0SB
b5kkwapPN/EtNhCVvxh9DgBIAvsqajyCu7ShrPMW6PL0PkiONRJkGDfLy/XO2WPX
TdD94fsJPF8S4gUzZmykQTqJMXg+/20AmP+Xt0JOHEbxuFHIf6sdKVucCX+ZeLj9
UA117smTmV44fR+nhfXMxIBTv7yeVitmOP5eXtxsgwIDAQABo1MwUTAdBgNVHQ4E
FgQUOnSJr3zw443NzZNop9156cOmJbUwHwYDVR0jBBgwFoAUOnSJr3zw443NzZNo
p9156cOmJbUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAGJ0f
q1yoAtXoRSRGk+kTjGfd0lQIwzD9oJsAF0QuLM8bgdJeu8EeflWh0F/G5QXTsHbD
h4ZL5AhmFnwER4Q1zI7hUi8aXseYi3OtuJa/GkGiuCxyrJsbbneTCHgnD/N9d1Pd
c0v1MiWJbFOBrd0yVtFVpkz3SARIV6eIQbCLuOQlbTA7KCbY87as18akl5NWSf3u
wY7APtgIOEKKnggM+mjf5nx/RKALZJd0Gebgq33SvPDyHr6WVnz62VIPGR/nFwwt
VDQibM4L4OtZqtidiCgOoXh1HCk3Jii8CHGGbfnkYKn1BhjFPcteYq/Voevy3VaR
LyN+g8wbnvTzGCgK1g==
-----END CERTIFICATE-----`;

function tunnelMessage(id: string, sequenceNumber: number) {
  return createEdgeTunnelMessage({
    payload: {
      id,
      idempotency_key: id,
      organization_id: ORGANIZATION_ID,
      conversation_id: CONVERSATION_ID,
      endpoint_id: ENDPOINT_ID,
      channel: "telegram",
      direction: "inbound",
      sender_type: "client",
      sequence_number: sequenceNumber,
      type: "text",
      content: { text: `сетевой туннель ${sequenceNumber}` },
      status: "received",
      created_at: "2026-07-06T10:10:00.000Z",
      updated_at: "2026-07-06T10:10:00.000Z",
    },
    receivedAt: "2026-07-06T10:10:01.000Z",
  });
}

function createAppEndpoint() {
  const accepted = [];
  const endpoint = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    handle: (message) => {
      accepted.push(message);
      return {
        accepted: true,
        duplicate: false,
        message_id: message.payload.id,
      };
    },
  });
  return { endpoint, accepted };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return address.port;
}

async function close(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("VPN Tunnel network transport (MP-12)", () => {
  it("доставляет C9 через реальный TCP socket между Edge и App", async () => {
    const { endpoint, accepted } = createAppEndpoint();
    const appServer = createVpnTunnelTcpAppServer({ endpoint });
    const port = await listen(appServer);

    try {
      const remoteServer = createVpnTunnelTcpRemoteServer({
        host: "127.0.0.1",
        port,
      });
      const client = createVpnTunnelEdgeClient({
        identity: { id: "edge-rf", certificate: EDGE_CERT },
        server: remoteServer,
        trustedCertificates: [APP_CERT],
        sessionSecret: SESSION_SECRET,
        sleep: async () => {},
      });

      await client.ensureConnected();
      const ack = await client.send(
        tunnelMessage("12345678-1234-4234-8234-1234567890a1", 1),
      );

      assert.equal(ack.accepted, true);
      assert.equal(ack.message_id, "12345678-1234-4234-8234-1234567890a1");
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].payload.content.text, "сетевой туннель 1");
      assert.equal(remoteServer.getMetrics().tcp_request_total, 2);
    } finally {
      await close(appServer);
    }
  });

  it("доставляет C9 через реальный TCP/TLS socket между Edge и App", async () => {
    const { endpoint, accepted } = createAppEndpoint();
    const appServer = createVpnTunnelTcpAppServer({
      endpoint,
      tls: { key: TLS_KEY, cert: TLS_CERT },
    });
    const port = await listen(appServer);

    try {
      const remoteServer = createVpnTunnelTcpRemoteServer({
        url: `tcps://127.0.0.1:${port}`,
        tls: { ca: TLS_CERT, servername: "localhost" },
      });
      const client = createVpnTunnelEdgeClient({
        identity: { id: "edge-rf", certificate: EDGE_CERT },
        server: remoteServer,
        trustedCertificates: [APP_CERT],
        sessionSecret: SESSION_SECRET,
        sleep: async () => {},
      });

      await client.ensureConnected();
      const ack = await client.send(
        tunnelMessage("12345678-1234-4234-8234-1234567890a3", 3),
      );

      assert.equal(ack.accepted, true);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].payload.content.text, "сетевой туннель 3");
      assert.equal(remoteServer.getMetrics().tcp_request_total, 2);
    } finally {
      await close(appServer);
    }
  });

  it("включает TLS handshake для tcps:// даже без отдельных TLS options", async () => {
    let firstChunk: Buffer | null = null;
    const tcpServer = createTcpServer((socket) => {
      socket.once("data", (chunk) => {
        firstChunk = chunk;
        socket.destroy();
      });
    });
    const port = await listen(tcpServer);

    try {
      const remoteServer = createVpnTunnelTcpRemoteServer({
        url: `tcps://127.0.0.1:${port}`,
        timeoutMs: 500,
      });

      await assert.rejects(() => remoteServer.handshake({ nonce: "probe" }));

      assert.ok(firstChunk);
      assert.equal(firstChunk[0], 0x16);
    } finally {
      await close(tcpServer);
    }
  });

  it("переключается на WSS/WS fallback с тем же pre-shared tunnel secret", async () => {
    const { endpoint, accepted } = createAppEndpoint();
    const fallbackServer = createVpnTunnelWebSocketAppServer({
      endpoint,
      path: "/vpn",
    });
    const fallbackPort = await listen(fallbackServer);

    try {
      const primary = createVpnTunnelTcpRemoteServer({
        host: "127.0.0.1",
        port: fallbackPort + 1000,
      });
      const fallback = createVpnTunnelWebSocketRemoteServer({
        url: `ws://127.0.0.1:${fallbackPort}/vpn`,
      });
      const remoteServer = createFailoverVpnTunnelRemoteServer({ primary, fallback });
      const client = createVpnTunnelEdgeClient({
        identity: { id: "edge-rf", certificate: EDGE_CERT },
        server: remoteServer,
        trustedCertificates: [APP_CERT],
        sessionSecret: SESSION_SECRET,
        sleep: async () => {},
      });

      await client.ensureConnected();
      const ack = await client.send(
        tunnelMessage("12345678-1234-4234-8234-1234567890a2", 2),
      );

      assert.equal(ack.accepted, true);
      assert.equal(accepted.length, 1);
      assert.equal(remoteServer.getMetrics().fallback_total, 2);
      assert.equal(fallback.getMetrics().websocket_request_total, 2);
    } finally {
      await close(fallbackServer);
    }
  });
});
