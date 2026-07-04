import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateEdgeTunnelAck } from "../../packages/contracts/src/c9.mjs";
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

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000901";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000009c1";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000009e1";

const IDS = {
  1: "30000000-0000-4000-8000-000000000901",
  2: "30000000-0000-4000-8000-000000000902",
  3: "30000000-0000-4000-8000-000000000903",
  4: "30000000-0000-4000-8000-000000000904",
};

// Тестовые фикстуры (не реальные секреты): pre-shared секрет VPN-туннеля и сертификаты mTLS.
const SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 5);
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

const PLAINTEXT = "секретное сообщение субъекта РФ";

function createClock() {
  let tick = 0;
  return () => `2026-07-04T12:00:00.${String(tick++).padStart(3, "0")}Z`;
}

/** Входящее RF-сообщение (канонический C1 без sequence_number — присваивается на Edge). */
function inbound({ id, endpoint = ENDPOINT_ID, text = PLAINTEXT }) {
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
    created_at: "2026-07-04T11:00:00.000Z",
    updated_at: "2026-07-04T11:00:00.000Z",
  };
}

/**
 * Сквозной стек CP-7: Edge Cluster РФ (RF-first: секвенсор + шифр + RF-буфер) →
 * VPN Tunnel (mTLS) → реальная координация приёма ядра (createEdgeIntakeCoordinator) →
 * реальный Communication Core (M1). Ядро восстанавливает порядок по sequence_number
 * и дедуплицирует по idempotency_key — совместная зона SVC-EDGE ↔ SVC-CORE (§7.10/§11.12).
 */
function buildStack() {
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock: createClock() });
  const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });

  const link = createVpnLink();
  const app = createVpnTunnelAppEndpoint({
    identity: { id: "app-core", certificate: APP_CERT },
    trustedCertificates: [EDGE_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    // App-контур: C9 из туннеля уходит в реальную координацию приёма ядра.
    handle: (tunnelMessage) => intake.intake(tunnelMessage),
  });
  const tunnel = createVpnTunnelEdgeClient({
    identity: { id: "edge-rf", certificate: EDGE_CERT },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    sleep: async () => {},
  });

  const bufferStore = createInMemoryEdgeMessageBufferStore();
  const cipher = createRfPayloadCipher({ key: CIPHER_KEY });
  const cluster = createEdgeCluster({
    cipher,
    tunnel,
    sequencer: createEdgeSequencer(),
    bufferStore,
    now: createClock(),
  });

  return { store, core, intake, link, app, tunnel, bufferStore, cipher, cluster };
}

function listCoreMessages(core) {
  return core.listConversationMessages({
    organizationId: ORGANIZATION_ID,
    conversationId: CONVERSATION_ID,
  });
}

describe("E2E CP-7 «Edge Cluster»: РФ → VPN Tunnel → обработка ядром", () => {
  it("проводит РФ-трафик через Edge и VPN в ядро: sequence на входе, шифрование в РФ, доставка", async () => {
    const { core, tunnel, bufferStore, cipher, cluster } = buildStack();
    tunnel.connect();

    const result = await cluster.ingest(inbound({ id: IDS[1] }));

    // §7.10 — sequence_number присвоен на входе Edge; §7.14 — зафиксировано в РФ и переслано.
    assert.equal(result.sequence_number, 1);
    assert.equal(result.duplicate, false);
    assert.equal(result.fixed_in_rf, true);
    assert.equal(result.forwarded, true);

    // C9-ack от реального ядра валиден по контракту и подтверждает приём.
    const ackValidation = validateEdgeTunnelAck(result.ack);
    assert.equal(ackValidation.valid, true, ackValidation.errors.join("\n"));
    assert.equal(result.ack.accepted, true);
    assert.equal(result.ack.idempotency_key, IDS[1]);
    assert.equal(result.ack.sequence_number, 1);

    // Сообщение материализовалось в ядре (App-контур) с сохранёнными ключами порядка.
    const messages = await listCoreMessages(core);
    assert.equal(messages.data.length, 1);
    assert.equal(messages.data[0].id, IDS[1]);
    assert.equal(messages.data[0].sequence_number, 1);
    assert.equal(messages.data[0].content.text, PLAINTEXT);

    // §7.14 — первичная фиксация ПДн осталась в RF-контуре как шифртекст (не открытый текст).
    const stored = await bufferStore.get(IDS[1]);
    assert.ok(stored.forwarded_at, "успешная пересылка помечена forwarded_at");
    assert.equal(await cluster.pendingCount(), 0);
    assert.ok(Buffer.isBuffer(stored.payload_encrypted));
    assert.equal(
      stored.payload_encrypted.includes(Buffer.from(PLAINTEXT, "utf8")),
      false,
      "ПДн не хранятся в РФ-буфере в открытом виде",
    );
    const aad = { endpoint_id: ENDPOINT_ID, sequence_number: 1, idempotency_key: IDS[1] };
    assert.equal(cipher.decrypt(stored.payload_encrypted, { aad }).content.text, PLAINTEXT);

    const metrics = cluster.getMetrics();
    assert.equal(metrics.ingested_total, 1);
    assert.equal(metrics.fixed_in_rf_total, 1);
    assert.equal(metrics.forwarded_total, 1);
    assert.equal(metrics.buffered_offline_total, 0);
  });

  it("потеря VPN-соединения: РФ-буфер переживает разрыв, дренаж восстанавливает порядок в ядре без дублей", async () => {
    const { core, tunnel, link, cluster } = buildStack();
    tunnel.connect();

    // 1. Онлайн: первое сообщение доставляется в ядро немедленно.
    const online = await cluster.ingest(inbound({ id: IDS[1] }));
    assert.equal(online.forwarded, true);

    // 2. Разрыв VPN Tunnel: три сообщения копятся в РФ-буфере, приходит повтор.
    link.cut();
    await cluster.ingest(inbound({ id: IDS[2] }));
    await cluster.ingest(inbound({ id: IDS[3] }));
    await cluster.ingest(inbound({ id: IDS[4] }));
    const duplicateOffline = await cluster.ingest(inbound({ id: IDS[2], text: "повтор в офлайне" }));

    assert.equal(duplicateOffline.duplicate, true, "повтор дедуплицируется на входе Edge");
    assert.equal(await cluster.pendingCount(), 3, "повтор не занимает вторую ячейку буфера");
    let coreState = await listCoreMessages(core);
    assert.equal(coreState.data.length, 1, "офлайн — за рубеж ушло только онлайн-сообщение");

    // 3. Восстановление канала → авто-дренаж (ensureConnected + пересылка pending).
    link.restore();
    const drain = await cluster.drain();
    assert.equal(drain.drained, 3);
    assert.deepEqual(
      drain.forwarded.map((f) => f.sequence_number),
      [2, 3, 4],
      "дренаж соблюдает порядок (endpoint_id, sequence_number)",
    );

    // 4. В ядре сообщения лежат строго по возрастанию sequence_number, без потерь.
    coreState = await listCoreMessages(core);
    assert.deepEqual(
      coreState.data.map((m) => m.sequence_number),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      coreState.data.map((m) => m.id),
      [IDS[1], IDS[2], IDS[3], IDS[4]],
    );
    assert.equal(await cluster.pendingCount(), 0);

    // 5. Повторный дренаж идемпотентен — без дублей в ядре (например, потерянные ack).
    const redrain = await cluster.drain();
    assert.equal(redrain.drained, 0);
    const afterRedrain = await listCoreMessages(core);
    assert.equal(afterRedrain.data.length, 4, "повторный дренаж не создаёт дублей");

    const metrics = cluster.getMetrics();
    assert.equal(metrics.forwarded_total, 1, "онлайн переслано ровно одно");
    assert.equal(metrics.buffered_offline_total, 3);
    assert.equal(metrics.drained_total, 3);
    assert.equal(metrics.duplicate_total, 1);
  });
});
