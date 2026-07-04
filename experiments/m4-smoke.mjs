import assert from "node:assert/strict";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createEdgeIntakeCoordinator,
  createBroadcastDeliveryCoordinator,
  createMockC2EgressAdapter,
} from "../services/backend/src/modules/communication-core/index.mjs";
import { createEdgeTunnelMessage } from "../packages/contracts/src/c9.mjs";
import { createBroadcastCoreDeliveryDraft } from "../packages/contracts/src/c8.mjs";

const ORG = "10000000-0000-4000-8000-000000000101";
const ENDPOINT = "10000000-0000-4000-8000-0000000009e1";
let t = 0;
const clock = () => `2026-07-04T09:00:00.${String(t++).padStart(3, "0")}Z`;

function canonical({ id, seq }) {
  return {
    id,
    idempotency_key: id,
    organization_id: ORG,
    conversation_id: "20000000-0000-4000-8000-0000000009c1",
    endpoint_id: ENDPOINT,
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: seq,
    type: "text",
    content: { text: `msg ${seq}` },
    status: "received",
    created_at: "2026-07-04T08:00:00.000Z",
    updated_at: "2026-07-04T08:00:00.000Z",
    metadata: {},
  };
}

function tunnel({ id, seq }) {
  const payload = canonical({ id, seq });
  return createEdgeTunnelMessage({ payload, receivedAt: "2026-07-04T08:00:00.000Z" });
}

// --- CP-7: edge intake order recovery + dedup ---
{
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock });
  const intake = createEdgeIntakeCoordinator({ core, clock });

  const ids = {
    1: "30000000-0000-4000-8000-000000000001",
    2: "30000000-0000-4000-8000-000000000002",
    3: "30000000-0000-4000-8000-000000000003",
  };
  // out of order: 3, 1, 2 + duplicate of 1
  const batch = [
    tunnel({ id: ids[3], seq: 3 }),
    tunnel({ id: ids[1], seq: 1 }),
    tunnel({ id: ids[2], seq: 2 }),
    tunnel({ id: ids[1], seq: 1 }),
  ];
  const result = await intake.intakeBatch(batch);
  assert.equal(result.received, 4);
  assert.equal(result.forwarded, 3, "3 unique forwarded");
  assert.equal(result.duplicates, 1, "1 duplicate");
  assert.equal(result.reordered, true, "reorder detected");

  const messages = await core.listConversationMessages({
    organizationId: ORG,
    conversationId: "20000000-0000-4000-8000-0000000009c1",
  });
  const seqs = messages.data.map((m) => m.sequence_number);
  assert.deepEqual(seqs, [1, 2, 3], `stored in order, got ${seqs}`);

  // re-drain same buffer -> all duplicates, no new messages
  const redrain = await intake.intakeBatch(batch);
  assert.equal(redrain.forwarded, 0, "redrain forwards nothing");
  assert.equal(redrain.duplicates, 4, "all duplicates on redrain");
  console.log("CP-7 edge intake: OK");
}

// --- CP-6: broadcast delivery through core with retries ---
{
  const store = new InMemoryCommunicationCoreStore();
  const core = createCommunicationCoreM1Service({ store, clock });
  // First establish an endpoint/conversation via inbound ingress
  const inbound = await core.acceptIngressMessage(
    canonical({ id: "40000000-0000-4000-8000-000000000001", seq: 1 }),
  );
  const conversationId = inbound.conversation_id;
  const endpointId = inbound.endpoint_id;

  // egress adapter that fails once, then succeeds
  let calls = 0;
  const flakyAdapter = {
    async deliver(delivery) {
      calls += 1;
      if (calls === 1) return { accepted: false, error: "temporary" };
      return { accepted: true, status: "sent" };
    },
  };

  const coordinator = createBroadcastDeliveryCoordinator({
    store,
    egressAdapter: flakyAdapter,
    clock,
    maxAttempts: 3,
  });

  const broadcastId = "50000000-0000-4000-8000-000000000001";
  const draft = createBroadcastCoreDeliveryDraft({
    broadcastId,
    organizationId: ORG,
    messageId: "60000000-0000-4000-8000-000000000001",
    conversationId,
    endpointId,
    channel: "web_chat",
    text: "Кампания привет",
    createdAt: "2026-07-04T09:00:00.000Z",
  });

  const res = await coordinator.deliver(draft);
  assert.equal(res.delivered, true, "delivered after retry");
  assert.equal(res.status, "sent");
  assert.equal(res.broadcast_message_status, "sent");
  assert.equal(res.attempts.length, 2, `2 attempts recorded, got ${res.attempts.length}`);
  assert.equal(res.attempts[0].status, "failed");
  assert.equal(res.attempts[1].status, "sent");

  const links = store.getBroadcastMessages();
  assert.equal(links.length, 1);
  assert.equal(links[0].message_id, "60000000-0000-4000-8000-000000000001");

  // dedup: re-deliver same draft -> duplicate, no extra adapter call
  const callsBefore = calls;
  const dup = await coordinator.deliver(draft);
  assert.equal(dup.duplicate, true, "second delivery is duplicate");
  assert.equal(calls, callsBefore, "no extra adapter call on duplicate");

  // verify message went through core as outbound broadcast
  const msgs = await core.listConversationMessages({ organizationId: ORG, conversationId });
  const bcast = msgs.data.find((m) => m.sender_type === "broadcast");
  assert.ok(bcast, "broadcast message present in conversation");
  assert.equal(bcast.direction, "outbound");
  console.log("CP-6 broadcast delivery: OK");
}

console.log("ALL SMOKE OK");
