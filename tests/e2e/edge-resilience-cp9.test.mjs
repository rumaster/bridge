import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000009901";
const CONVERSATION_ID = "20000000-0000-4000-8000-0000000099c1";
const ENDPOINT_A = "10000000-0000-4000-8000-0000000099a1";
const ENDPOINT_B = "10000000-0000-4000-8000-0000000099b1";

const IDS = {
  a1: "30000000-0000-4000-8000-0000000099a1",
  a2: "30000000-0000-4000-8000-0000000099a2",
  b1: "30000000-0000-4000-8000-0000000099b1",
};

const SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");
const CIPHER_KEY = Buffer.alloc(RF_PAYLOAD_KEY_BYTES, 13);
const APP_CERT = "app-core-cert-fingerprint";

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-04T18:00:00.000Z") + tick++ * 1000).toISOString();
}

function inbound({ id, endpoint, text }) {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    conversation_id: CONVERSATION_ID,
    endpoint_id: endpoint,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    type: "text",
    content: { text },
    status: "received",
    created_at: "2026-07-04T17:59:00.000Z",
    updated_at: "2026-07-04T17:59:00.000Z",
  };
}

function createEdge({ certificate, coreIntake, edgeId }) {
  const link = createVpnLink();
  const app = createVpnTunnelAppEndpoint({
    identity: { id: `app-core-${edgeId}`, certificate: APP_CERT },
    trustedCertificates: [certificate],
    sessionSecret: SESSION_SECRET,
    link,
    handle: (tunnelMessage) => coreIntake.intake(tunnelMessage),
  });
  const tunnel = createVpnTunnelEdgeClient({
    identity: { id: edgeId, certificate },
    server: app,
    trustedCertificates: [APP_CERT],
    sessionSecret: SESSION_SECRET,
    link,
    sleep: async () => {},
    clientId: edgeId,
  });
  const cluster = createEdgeCluster({
    cipher: createRfPayloadCipher({ key: CIPHER_KEY }),
    tunnel,
    sequencer: createEdgeSequencer(),
    bufferStore: createInMemoryEdgeMessageBufferStore({ capacity: 10 }),
    now: createClock(),
    region: edgeId,
  });

  return { cluster, link, tunnel };
}

async function listCoreMessages(core) {
  return core.listConversationMessages({
    organizationId: ORGANIZATION_ID,
    conversationId: CONVERSATION_ID,
  });
}

describe("E2E CP-9 SVC-EDGE — отказоустойчивость Edge Cluster", () => {
  it("недоступность отдельного Edge не останавливает приём через другой Edge", async () => {
    const store = new InMemoryCommunicationCoreStore();
    const core = createCommunicationCoreM1Service({ store, clock: createClock() });
    const intake = createEdgeIntakeCoordinator({ core, clock: createClock() });
    const edgeA = createEdge({
      certificate: "edge-a-cert-fingerprint",
      coreIntake: intake,
      edgeId: "edge-a",
    });
    const edgeB = createEdge({
      certificate: "edge-b-cert-fingerprint",
      coreIntake: intake,
      edgeId: "edge-b",
    });

    edgeA.tunnel.connect();
    edgeB.tunnel.connect();

    edgeA.link.cut();
    const bufferedOnA = await edgeA.cluster.ingest(
      inbound({ id: IDS.a1, endpoint: ENDPOINT_A, text: "edge A offline" }),
    );
    const deliveredThroughB = await edgeB.cluster.ingest(
      inbound({ id: IDS.b1, endpoint: ENDPOINT_B, text: "edge B online" }),
    );

    assert.equal(bufferedOnA.forwarded, false);
    assert.equal(await edgeA.cluster.pendingCount(), 1);
    assert.equal(deliveredThroughB.forwarded, true);

    let messages = await listCoreMessages(core);
    assert.deepEqual(messages.data.map((message) => message.id), [IDS.b1]);

    edgeA.link.restore();
    const recoveredOnA = await edgeA.cluster.ingest(
      inbound({ id: IDS.a2, endpoint: ENDPOINT_A, text: "edge A recovered" }),
    );

    assert.equal(recoveredOnA.auto_drained, 2);
    assert.equal(await edgeA.cluster.pendingCount(), 0);

    messages = await listCoreMessages(core);
    assert.deepEqual(
      messages.data.map((message) => message.id).sort(),
      [IDS.a1, IDS.a2, IDS.b1],
    );
    assert.deepEqual(
      messages.data
        .filter((message) => message.endpoint_id === ENDPOINT_A)
        .map((message) => message.sequence_number),
      [1, 2],
      "порядок сохраняется внутри одного endpoint; между endpoint глобальный порядок не требуется",
    );
  });
});
