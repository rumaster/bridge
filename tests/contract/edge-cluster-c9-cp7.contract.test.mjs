import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C9_CONTRACT,
  createEdgeTunnelMessage,
  validateEdgeTunnelAck,
  validateEdgeTunnelMessage,
} from "../../packages/contracts/src/c9.mjs";
import { validateCanonicalMessage } from "../../packages/contracts/message-model/index.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../services/backend/src/modules/communication-core/index.mjs";
import { createEdgeCluster } from "../../services/edge-gateway/src/edge-cluster.mjs";
import { createInMemoryEdgeMessageBufferStore } from "../../services/edge-gateway/src/edge-message-buffer.mjs";
import { createEdgeSequencer } from "../../services/edge-gateway/src/edge-sequencer.mjs";
import {
  RF_PAYLOAD_KEY_BYTES,
  createRfPayloadCipher,
} from "../../services/edge-gateway/src/rf-payload-cipher.mjs";
import {
  createVpnLink,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
} from "../../services/edge-gateway/src/vpn-tunnel.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000a01";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000ac1";
const ENDPOINT_ID = "10000000-0000-4000-8000-000000000ae1";

const IDS = {
  1: "30000000-0000-4000-8000-000000000a01",
  2: "30000000-0000-4000-8000-000000000a02",
};

// Тестовые фикстуры (не реальные секреты).
const SESSION_SECRET = Buffer.alloc(32, 4).toString("base64");
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 6);
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T13:00:00.${String(tick++).padStart(3, "0")}Z`;
}

function inbound({ id, endpoint = ENDPOINT_ID, text = "контрактное сообщение" }) {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: endpoint,
    channel: "telegram",
    direction: "inbound",
    sender_type: "client",
    type: "text",
    content: { text },
    status: "received",
    created_at: "2026-07-04T12:00:00.000Z",
    updated_at: "2026-07-04T12:00:00.000Z",
  };
}

/**
 * Стек для контрактной проверки EDGE ↔ CORE (C9 с C1): реальный Edge Cluster эмитит
 * C9-конверты через VPN Tunnel в реальный createEdgeIntakeCoordinator. Перехватываем
 * туннельные сообщения на App-стороне, чтобы проверить их против контракта C9/C1.
 */
function buildStack() {
  const captured = [];
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock: createClock() });
  const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

  const link = createVpnLink();
  const app = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    handle: (tunnelMessage) => {
      captured.push(tunnelMessage);
      return intake.intake(tunnelMessage);
    },
  });
  const tunnel = createVpnTunnelEdgeClient({
    identity: { id: "edge-rf", certificate: EDGE_CERT },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    sleep: async () => {},
  });
  const cluster = createEdgeCluster({
    cipher: createRfPayloadCipher({ key: CIPHER_KEY }),
    tunnel,
    sequencer: createEdgeSequencer(),
    bufferStore: createInMemoryEdgeMessageBufferStore(),
    now: createClock(),
  });

  return { captured, cluster, tunnel };
}

describe("Контракт CP-7 EDGE ↔ CORE: Edge Cluster эмитит валидный C9 с полезной нагрузкой C1", () => {
  it("каждое туннельное сообщение — валидный C9-конверт с валидным C1 и сохранёнными ключами порядка", async () => {
    const { captured, cluster, tunnel } = buildStack();
    tunnel.connect();

    await cluster.ingest(inbound({ id: IDS[1] }));
    await cluster.ingest(inbound({ id: IDS[2] }));

    assert.equal(captured.length, 2);

    captured.forEach((tunnelMessage, index) => {
      const c9 = validateEdgeTunnelMessage(tunnelMessage);
      assert.equal(c9.valid, true, `C9 #${index + 1}: ${c9.errors.join("; ")}`);
      assert.equal(tunnelMessage.contract, C9_CONTRACT);

      // Полезная нагрузка — валидный канонический C1.
      const c1 = validateCanonicalMessage(tunnelMessage.payload);
      assert.equal(c1.valid, true, `C1 #${index + 1}: ${c1.errors.join("; ")}`);

      // Ключи порядка/идемпотентности продублированы в конверте и совпадают с C1.
      assert.equal(tunnelMessage.endpoint_id, tunnelMessage.payload.endpoint_id);
      assert.equal(tunnelMessage.sequence_number, tunnelMessage.payload.sequence_number);
      assert.equal(tunnelMessage.idempotency_key, tunnelMessage.payload.idempotency_key);
      assert.equal(tunnelMessage.sequence_number, index + 1);
    });
  });

  it("реальный createEdgeIntakeCoordinator возвращает валидный C9-ack на конверт Edge Cluster", async () => {
    const { cluster, tunnel } = buildStack();
    tunnel.connect();

    const result = await cluster.ingest(inbound({ id: IDS[1] }));

    const ack = validateEdgeTunnelAck(result.ack);
    assert.equal(ack.valid, true, ack.errors.join("\n"));
    assert.equal(result.ack.accepted, true);
    assert.equal(result.ack.duplicate, false);
    assert.equal(result.ack.endpoint_id, ENDPOINT_ID);
    assert.equal(result.ack.sequence_number, 1);
    assert.equal(result.ack.idempotency_key, IDS[1]);
  });

  it("повторная отправка того же idempotency_key даёт C9-ack с duplicate=true (дедуп совместно с ядром)", async () => {
    const { cluster, tunnel } = buildStack();
    tunnel.connect();

    await cluster.ingest(inbound({ id: IDS[1] }));
    // Повтор на входе Edge не доходит до туннеля (дедуп в РФ-буфере), поэтому сквозной повтор
    // по idempotency_key проверяем отдельной туннельной пересылкой на приёмник (ядро).
    const forced = await tunnel.send(
      createEdgeTunnelMessage({
        payload: { ...inbound({ id: IDS[1] }), idempotency_key: IDS[1], sequence_number: 1 },
        receivedAt: "2026-07-04T13:00:05.000Z",
      }),
    );

    const ack = validateEdgeTunnelAck(forced);
    assert.equal(ack.valid, true, ack.errors.join("\n"));
    assert.equal(forced.accepted, true);
    assert.equal(forced.duplicate, true, "ядро распознало сквозной повтор по idempotency_key");
  });
});
