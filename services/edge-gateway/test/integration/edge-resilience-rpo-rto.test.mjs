import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
} from "../../../backend/src/modules/communication-core/index.mjs";
import { createEdgeCluster } from "../../src/edge-cluster.mjs";
import { createInMemoryEdgeMessageBufferStore } from "../../src/edge-message-buffer.mjs";
import { createEdgeSequencer } from "../../src/edge-sequencer.mjs";
import {
  RF_PAYLOAD_KEY_BYTES,
  createRfPayloadCipher,
} from "../../src/rf-payload-cipher.mjs";
import {
  createVpnLink,
  createVpnTunnelAppEndpoint,
  createVpnTunnelEdgeClient,
} from "../../src/vpn-tunnel.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000001701";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000017c1";
const ENDPOINT_ID = "10000000-0000-4000-8000-0000000017e1";

const IDS = {
  1: "30000000-0000-4000-8000-000000001701",
  2: "30000000-0000-4000-8000-000000001702",
  3: "30000000-0000-4000-8000-000000001703",
};

const SESSION_SECRET = Buffer.alloc(32, 17).toString("base64");
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 11);
const EDGE_CERT = "edge-rf-cert-fingerprint";
const APP_CERT = "app-core-cert-fingerprint";

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-04T17:00:00.000Z") + tick++ * 1000).toISOString();
}

function inbound({ id, text = "edge m5" }) {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: ENDPOINT_ID,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    type: "text",
    content: { text },
    status: "received",
    created_at: "2026-07-04T16:59:00.000Z",
    updated_at: "2026-07-04T16:59:00.000Z",
  };
}

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
  const bufferStore = createInMemoryEdgeMessageBufferStore({ capacity: 10 });
  const cluster = createEdgeCluster({
    cipher: createRfPayloadCipher({ key: CIPHER_KEY }),
    tunnel,
    sequencer: createEdgeSequencer(),
    bufferStore,
    now: createClock(),
  });

  return { core, link, tunnel, cluster };
}

async function listCoreMessages(core) {
  return core.listConversationMessages({
    organizationId: ORGANIZATION_ID,
    conversationId: CONVERSATION_ID,
  });
}

describe("SVC-EDGE M5 — RPO/RTO и автосинхронизация после восстановления канала", () => {
  it("дренаж после восстановления возвращает измерения RPO/RTO и не теряет принятые сообщения", async () => {
    const { core, link, tunnel, cluster } = buildStack();
    tunnel.connect();

    link.cut();
    await cluster.ingest(inbound({ id: IDS[1] }));
    await cluster.ingest(inbound({ id: IDS[2] }));
    assert.equal(await cluster.pendingCount(), 2);

    link.restore();
    const drain = await cluster.drain();

    assert.equal(drain.drained, 2);
    assert.equal(drain.recovery.pending_before, 2);
    assert.equal(drain.recovery.pending_after, 0);
    assert.equal(drain.recovery.expired_skipped, 0);
    assert.equal(drain.recovery.rpo.capacity, 10);
    assert.equal(drain.recovery.rpo.ttl_expired, 0);
    assert.ok(drain.recovery.rto_ms >= 0);

    const messages = await listCoreMessages(core);
    assert.deepEqual(messages.data.map((message) => message.id), [IDS[1], IDS[2]]);
  });

  it("новый приём после восстановления канала автоматически синхронизирует старый backlog", async () => {
    const { core, link, tunnel, cluster } = buildStack();
    tunnel.connect();

    link.cut();
    await cluster.ingest(inbound({ id: IDS[1] }));
    await cluster.ingest(inbound({ id: IDS[2] }));
    assert.equal(await cluster.pendingCount(), 2);

    link.restore();
    const acceptedAfterRecovery = await cluster.ingest(inbound({ id: IDS[3] }));

    assert.equal(acceptedAfterRecovery.forwarded, true);
    assert.equal(acceptedAfterRecovery.auto_drained, 3);
    assert.equal(acceptedAfterRecovery.recovery.pending_before, 3);
    assert.equal(await cluster.pendingCount(), 0);

    const messages = await listCoreMessages(core);
    assert.deepEqual(
      messages.data.map((message) => message.id),
      [IDS[1], IDS[2], IDS[3]],
    );
  });
});
