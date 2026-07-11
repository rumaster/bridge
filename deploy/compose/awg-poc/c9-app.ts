// App-сторона C9 для PoC Этапа 0 (issue #257) — «текущий код» (Q4: RPC-плоскость
// vpn-transport.ts сохраняется как труба внутри туннеля). Терминирует TCP-RPC на
// туннельном IP App-стороны (10.7.0.1) и подтверждает валидные C9-сообщения
// C9-ack'ом. Прикладное крипто здесь ещё присутствует (снятие — Этап 2, Q2);
// цель Этапа 0 — доказать, что C9 физически проходит ВНУТРИ AmneziaWG-туннеля.
import { createEdgeTunnelAck } from "../../../packages/contracts/src/c9.js";
import { createVpnTunnelTcpAppServer } from "../../../services/edge-gateway/src/vpn-transport.js";
import { createVpnTunnelAppEndpoint } from "../../../services/edge-gateway/src/vpn-tunnel.js";

const host = process.env.C9_APP_HOST ?? "0.0.0.0";
const port = Number(process.env.C9_APP_PORT ?? 3049);

const endpoint = createVpnTunnelAppEndpoint({
  identity: {
    id: process.env.EDGE_VPN_APP_ID ?? "app-core",
    certificate: requireEnv("EDGE_VPN_APP_CERT"),
  },
  trustedCertificates: parseList(requireEnv("EDGE_VPN_TRUSTED_EDGE_CERTS")),
  sessionSecret: requireEnv("EDGE_VPN_SESSION_KEY"),
  handle(tunnelMessage: any) {
    const bytes = Buffer.byteLength(JSON.stringify(tunnelMessage), "utf8");
    console.log(
      `c9-app: принято C9 seq=${tunnelMessage.sequence_number} ` +
        `idem=${tunnelMessage.idempotency_key} (~${bytes} байт JSON)`,
    );
    return createEdgeTunnelAck({
      accepted: true,
      endpointId: tunnelMessage.endpoint_id,
      sequenceNumber: tunnelMessage.sequence_number,
      idempotencyKey: tunnelMessage.idempotency_key,
      coreStatus: "received",
      receivedAt: "2026-07-02T16:10:03.000Z",
    });
  },
});

const server = createVpnTunnelTcpAppServer({ endpoint });
server.listen(port, host, () => {
  console.log(`c9-app: TCP-RPC слушает ${host}:${port} (туннельный IP App-стороны)`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`c9-app: переменная ${name} обязательна`);
    process.exit(1);
  }
  return value;
}

function parseList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
