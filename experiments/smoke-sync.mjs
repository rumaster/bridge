import { createMockBackendApi } from "../services/mobile-api/src/backend-client.mjs";
import { createSyncEngine } from "../services/mobile-api/src/sync-engine.mjs";
import { aggregateDialogList, aggregateDialogMessages, aggregateNotifications } from "../services/mobile-api/src/aggregators.mjs";

let t = 0;
const now = () => `2026-07-04T12:00:00.${String(t++).padStart(3,"0")}Z`;
const ORG = "org-1", USER = "manager-1", DEV = "device-1", CONV = "conv-1";

const backend = createMockBackendApi({ now });
backend.seedClient({ organizationId: ORG, clientId: "client-1", displayName: "Ada" });
backend.seedConversation({ organizationId: ORG, conversationId: CONV, clientId: "client-1" });

const engine = createSyncEngine({ backend, context: { organizationId: ORG, userId: USER, deviceId: DEV }, now });

// initial sync (empty feed)
const s0 = engine.sync({ device_id: DEV });
console.log("s0 cursor", s0.cursor.slice(0,12), "has_more", s0.has_more, "deltas msgs", s0.deltas.messages.length);

// client sends inbound message via edge ingest
backend.ingestCanonicalMessage({ id:"m1", idempotency_key:"m1", organization_id:ORG, conversation_id:CONV, sender_type:"client", content:{text:"hi"}, sequence_number:1, status:"received", created_at: now() });
// manager replies (idempotent send)
const r1 = backend.sendMessage({ organizationId:ORG, conversationId:CONV, messageId:"m2", idempotencyKey:"m2", senderUserId:USER, text:"hello", occurredAt: now() });
const r1dup = backend.sendMessage({ organizationId:ORG, conversationId:CONV, messageId:"m2", idempotencyKey:"m2", senderUserId:USER, text:"hello", occurredAt: now() });
console.log("send dup?", r1.duplicate, r1dup.duplicate);
backend.createNotification({ organizationId:ORG, notificationId:"n1", recipientUserId:USER, category:"critical", title:"T", body:"B", payload:{dialog_id:CONV}, createdAt: now() });

// sync from s0 cursor
const s1 = engine.sync({ device_id: DEV, cursor: s0.cursor });
console.log("s1 deltas: dialogs", s1.deltas.dialogs.length, "messages", s1.deltas.messages.length, "notif", s1.deltas.notifications.length, "statuses", s1.deltas.statuses.map(x=>x.kind));
console.log("s1 dialog unread", s1.deltas.dialogs[0]?.unread_count, "last", s1.deltas.dialogs[0]?.last_message?.text);
console.log("s1 notif severity", s1.deltas.notifications[0]?.severity, "user", s1.deltas.notifications[0]?.user_id);
console.log("s1 has_more", s1.has_more);

// repeat sync with SAME cursor s0 -> same deltas (no dup/loss)
const s1again = engine.sync({ device_id: DEV, cursor: s0.cursor });
console.log("idempotent re-sync messages", s1again.deltas.messages.length, "== ", s1.deltas.messages.length);

// sync from s1 cursor -> empty
const s2 = engine.sync({ device_id: DEV, cursor: s1.cursor });
console.log("s2 empty messages", s2.deltas.messages.length, "dialogs", s2.deltas.dialogs.length, "has_more", s2.has_more);

// monotonic: parse sequences
import { assertSyncCursor } from "../services/mobile-api/src/sync-cursor.mjs";
const seq = c => assertSyncCursor(c).sequence;
console.log("seq monotonic", seq(s0.cursor), seq(s1.cursor), seq(s2.cursor));

// aggregators direct
const dialogs = aggregateDialogList({ conversations: backend.listConversations({organizationId:ORG}), messagesByConversation: new Map([[CONV, backend.listConversationMessages({organizationId:ORG, conversationId:CONV})]]), clientsById: new Map([["client-1", backend.getClient({organizationId:ORG, clientId:"client-1"})]]) });
console.log("agg dialog client", dialogs[0].client.display_name, "unread", dialogs[0].unread_count);
const msgs = aggregateDialogMessages({ messages: backend.listConversationMessages({organizationId:ORG, conversationId:CONV}) });
console.log("agg messages seq", msgs.map(m=>m.sequence_number), "sender", msgs.map(m=>m.sender_type));
console.log("backend metrics", JSON.stringify(backend.getMetrics()));
