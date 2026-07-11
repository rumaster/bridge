// Edge-сторона C9 для PoC Этапа 0 (issue #257) — «текущий код»: RPC-клиент
// vpn-transport.ts + Edge-клиент туннеля vpn-tunnel.ts. Подключается к App-стороне
// по ТУННЕЛЬНОМУ IP (EDGE_VPN_APP_TCP_URL=tcp://10.7.0.1:3049), т.е. трафик идёт
// ВНУТРИ AmneziaWG-туннеля. Прогоняет два кадра: обычный и «по верхней границе
// 2 МБ» (Q8), проверяет C9-ack и отсутствие залипаний. Exit 0 = DoD Этапа 0 закрыт.
import { buildTunnelMessage } from "./c9-fixtures.js";
import { createVpnTunnelTcpRemoteServer } from "../../../services/edge-gateway/src/vpn-transport.js";
import { createVpnTunnelEdgeClient } from "../../../services/edge-gateway/src/vpn-tunnel.js";

const url = requireEnv("EDGE_VPN_APP_TCP_URL");
const connectTimeoutMs = Number(process.env.C9_PROBE_CONNECT_TIMEOUT_MS ?? 60_000);
// content.text для «большого» кадра. По умолчанию ~1.3 МБ текста → sealed+base64
// RPC-кадр ~1.85 МБ, т.е. под лимитом vpn-transport (2 МБ), но с обильной
// фрагментацией по UDP-туннелю — именно то, что проверяет Q8.
const largeContentBytes = Number(process.env.C9_PROBE_CONTENT_BYTES ?? 1_300_000);

const remote = createVpnTunnelTcpRemoteServer({
  url,
  timeoutMs: Number(process.env.EDGE_VPN_TIMEOUT_MS ?? 30_000),
});
// appCrypto=off — единый слой (Этап 2): крипто делегировано AmneziaWG.
const appCrypto = process.env.EDGE_VPN_APP_CRYPTO !== "off";
const client = createVpnTunnelEdgeClient({
  identity: {
    id: process.env.EDGE_VPN_EDGE_ID ?? "edge-rf",
    certificate: appCrypto ? requireEnv("EDGE_VPN_EDGE_CERT") : (process.env.EDGE_VPN_EDGE_ID ?? "edge-rf"),
  },
  server: remote,
  trustedCertificates: appCrypto ? parseList(requireEnv("EDGE_VPN_TRUSTED_APP_CERTS")) : [],
  sessionSecret: appCrypto ? requireEnv("EDGE_VPN_SESSION_KEY") : undefined,
  clientId: process.env.EDGE_VPN_CLIENT_ID ?? "edge-rf",
  appCrypto,
});

async function main() {
  console.log(`c9-probe: подключаюсь к App по туннельному IP ${url}`);
  await connectWithRetry();
  console.log("c9-probe: туннельный C9-handshake установлен");

  await sendAndAssert("обычный кадр", buildTunnelMessage({ sequenceNumber: 1 }));
  await sendAndAssert(
    `большой кадр (~${largeContentBytes} байт content)`,
    buildTunnelMessage({ sequenceNumber: 2, contentBytes: largeContentBytes }),
  );

  console.log("c9-probe: DoD Этапа 0 подтверждён — C9 прошёл внутри AmneziaWG-туннеля");
  console.log(`c9-probe: метрики клиента ${JSON.stringify(client.getMetrics())}`);
  process.exit(0);
}

async function connectWithRetry() {
  const deadline = Date.now() + connectTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.connectAsync();
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(
    `c9-probe: не удалось поднять C9-туннель за ${connectTimeoutMs} мс: ${String(lastError)}`,
  );
}

async function sendAndAssert(label: string, message: any) {
  const startedAt = Date.now();
  const ack = await client.send(message);
  const elapsed = Date.now() - startedAt;
  if (!ack || ack.accepted !== true) {
    throw new Error(`c9-probe: ${label} — App не подтвердил C9 (ack=${JSON.stringify(ack)})`);
  }
  if (ack.sequence_number !== message.sequence_number) {
    throw new Error(`c9-probe: ${label} — seq в ack не совпал (${ack.sequence_number})`);
  }
  console.log(`c9-probe: ✓ ${label} доставлен и подтверждён за ${elapsed} мс`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`c9-probe: переменная ${name} обязательна`);
    process.exit(1);
  }
  return value;
}

function parseList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

main().catch((error) => {
  console.error(`c9-probe: ПРОВАЛ — ${error?.stack ?? error}`);
  process.exit(1);
});
