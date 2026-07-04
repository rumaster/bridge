import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeTunnelMessage } from "../../../../packages/contracts/src/c9.mjs";
import {
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../../backend/src/modules/communication-core/index.mjs";
import {
  VpnTunnelChannelDownError,
  createVpnLink,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
} from "../../src/vpn-tunnel.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000b01";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000bc1";
const ENDPOINT_ID = "10000000-0000-4000-8000-000000000be1";

const IDS = {
  1: "30000000-0000-4000-8000-000000000b01",
  2: "30000000-0000-4000-8000-000000000b02",
  3: "30000000-0000-4000-8000-000000000b03",
};

// Тестовые фикстуры (не реальные секреты): pre-shared секрет VPN и сертификаты mTLS.
const SESSION_SECRET = Buffer.alloc(32, 2).toString("base64");
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T14:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function canonical({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "telegram",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `edge ${seq}` },
    status: "received",
    created_at: "2026-07-04T13:59:00.000Z",
    updated_at: "2026-07-04T13:59:00.000Z",
  };
}

function tunnelMessage({ id, seq }) {
  return createEdgeTunnelMessage({
    payload: canonical({ id, seq }),
    receivedAt: "2026-07-04T14:00:00.000Z",
  });
}

/**
 * Интеграция VPN Tunnel ↔ Communication Core (§7.8/§7.10, §26.4): реальный туннель
 * доставляет C9 в реальную координацию приёма ядра. Ядро восстанавливает порядок по
 * sequence_number и дедуплицирует по idempotency_key — приёмная сторона совместной зоны
 * SVC-EDGE ↔ SVC-CORE. `createVpnLink` играет роль channel-break mock.
 */
function buildTunnelToCore() {
  const core = createCommunicationCoreM1Service({ clock: createClock() });
  const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

  const link = createVpnLink();
  const app = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    handle: (message) => intake.intake(message),
  });
  const tunnel = createVpnTunnelEdgeClient({
    identity: { id: "edge-rf", certificate: EDGE_CERT },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    sleep: async () => {},
  });

  return { core, tunnel, link };
}

function listCoreMessages(core) {
  return core.listConversationMessages({
    organizationId: ORGANIZATION_ID,
    conversationId: CONVERSATION_ID,
  });
}

describe("VPN Tunnel ↔ Communication Core: восстановление порядка на разрыве канала (§7.10, §26.4)", () => {
  it("после разрыва и переподключения переставленная доставка приходит в ядро в порядке sequence_number", async () => {
    const { core, tunnel, link } = buildTunnelToCore();
    tunnel.connect();

    // 1. Онлайн: первое сообщение доставлено в ядро.
    const ack1 = await tunnel.send(tunnelMessage({ id: IDS[1], seq: 1 }));
    assert.equal(ack1.accepted, true);
    assert.equal(ack1.duplicate, false);

    // 2. Разрыв канала (channel-break mock) во время пересылки sequence 2.
    link.cut();
    await assert.rejects(
      () => tunnel.send(tunnelMessage({ id: IDS[2], seq: 2 })),
      VpnTunnelChannelDownError,
    );
    assert.equal(tunnel.isConnected(), false);

    // 3. Канал восстановился — туннель переустанавливается (авто-recovery).
    link.restore();
    await tunnel.ensureConnected();
    assert.equal(tunnel.isConnected(), true);
    assert.equal(tunnel.getMetrics().reconnect_total, 1);

    // 4. Ретрансмиссия после разрыва приходит НЕ ПО ПОРЯДКУ: sequence 3 раньше 2.
    const ack3 = await tunnel.send(tunnelMessage({ id: IDS[3], seq: 3 }));
    const ack2 = await tunnel.send(tunnelMessage({ id: IDS[2], seq: 2 }));
    assert.equal(ack3.accepted, true);
    assert.equal(ack2.accepted, true);
    assert.equal(ack2.duplicate, false);

    // 5. Повтор sequence 2 (потерянный ack ретрансмитнули ещё раз) — дедуп на приёмнике.
    const ackDup = await tunnel.send(tunnelMessage({ id: IDS[2], seq: 2 }));
    assert.equal(ackDup.accepted, true);
    assert.equal(ackDup.duplicate, true, "ядро распознало повтор по idempotency_key");

    // 6. Порядок в ядре восстановлен по sequence_number, дубль не создал лишней записи.
    const messages = await listCoreMessages(core);
    assert.deepEqual(
      messages.data.map((m) => m.sequence_number),
      [1, 2, 3],
      "приёмник восстановил порядок несмотря на переставленную доставку",
    );
    assert.deepEqual(
      messages.data.map((m) => m.id),
      [IDS[1], IDS[2], IDS[3]],
    );
    assert.equal(messages.data.length, 3, "сквозная дедупликация исключила дубль");
  });

  it("набор, накопленный за разрыв, дренажируется через туннель с восстановлением порядка и дедупом", async () => {
    const { core, tunnel, link } = buildTunnelToCore();
    tunnel.connect();

    // Разрыв: сообщения копятся вне ядра, приходят вперемешку и с повтором.
    link.cut();
    const buffered = [
      tunnelMessage({ id: IDS[3], seq: 3 }),
      tunnelMessage({ id: IDS[1], seq: 1 }),
      tunnelMessage({ id: IDS[2], seq: 2 }),
      tunnelMessage({ id: IDS[2], seq: 2 }), // повтор во время разрыва
    ];

    // Восстановление: накопленный набор уходит через туннель на приёмник ядра.
    link.restore();
    await tunnel.ensureConnected();
    const acks = [];
    for (const message of buffered) {
      acks.push(await tunnel.send(message));
    }

    assert.equal(acks.filter((ack) => ack.duplicate).length, 1, "ровно один повтор дедуплицирован");

    const messages = await listCoreMessages(core);
    assert.deepEqual(
      messages.data.map((m) => m.sequence_number),
      [1, 2, 3],
    );
    assert.equal(messages.data.length, 3);
  });
});
