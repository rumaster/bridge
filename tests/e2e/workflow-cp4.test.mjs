import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createBackendServer } from "../../services/backend/src/main.mjs";
import {
  InMemoryCommunicationCoreStore,
  createCommunicationCoreM1Service,
  createCommunicationCoreModule,
  createFbpWorkflowOutboxPublisher,
} from "../../services/backend/src/modules/communication-core/index.mjs";
import { createDeterministicFbpMock } from "../../services/fbp-engine/src/deterministic-fbp.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const INBOUND_MESSAGE_ID = "10000000-0000-4000-8000-000000000831";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("CP-4 Workflow: core domain event starts FBP workflow", () => {
  let core;
  let coreServer;
  let coreBaseUrl;
  let fbp;

  before(async () => {
    const store = new InMemoryCommunicationCoreStore();
    core = createCommunicationCoreM1Service({
      store,
      clock: () => "2026-07-03T13:00:00.000Z",
    });
    coreServer = createBackendServer({
      modules: [createCommunicationCoreModule({ core })],
    });
    coreBaseUrl = await listen(coreServer);
    fbp = createDeterministicFbpMock({
      now: () => "2026-07-03T13:01:00.000Z",
    });
  });

  after(async () => {
    await close(coreServer);
  });

  it("публикует событие ядра в outbox, запускает workflow в FBP-моке и фиксирует Backend API node callback", async () => {
    const ingressResponse = await fetch(`${coreBaseUrl}/api/v1/internal/ingress/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contract: "C2.IngressMessage",
        version: "1.0.0",
        idempotency_key: INBOUND_MESSAGE_ID,
        received_at: "2026-07-03T12:59:00.000Z",
        message: {
          message_id: INBOUND_MESSAGE_ID,
          organization_id: ORGANIZATION_ID,
          channel_id: "web-chat-channel",
          channel_type: "web_chat",
          external_message_id: "web-chat-message-cp4",
          conversation_ref: "web-chat-room-cp4",
          sender_ref: "visitor-cp4",
          direction: "inbound",
          content: {
            type: "text",
            text: "Запустить workflow по событию ядра",
          },
          occurred_at: "2026-07-03T12:59:00.000Z",
        },
      }),
    });
    const ingress = await ingressResponse.json();

    assert.equal(ingressResponse.status, 202);
    assert.equal(ingress.status, "routed");

    const replay = await core.publishOutboxEvents({
      organizationId: ORGANIZATION_ID,
      publisher: createFbpWorkflowOutboxPublisher({
        fbp,
        workflowId: "workflow-core-domain-events",
        workflowVersionId: "workflow-version-core-domain-events",
        actorUserId: "system",
      }),
    });

    assert.equal(replay.published_count, 3);
    assert.equal(fbp.getMetrics().workflow_start_total, 3);

    const started = replay.deliveries[0].result.response;
    assert.equal(started.contract, "C5.StartWorkflowInstanceResponse");
    assert.equal(started.status, "started");
    assert.equal(started.state.input.outbox_event.event_type, "conversation.created");

    const callback = fbp.recordBackendApiCallback({
      contract: "C5.BackendApiNodeCallbackRequest",
      version: "1.0.0",
      request_id: "req-cp4-backend-node-1",
      organization_id: ORGANIZATION_ID,
      workflow_id: "workflow-core-domain-events",
      workflow_version_id: "workflow-version-core-domain-events",
      instance_id: started.instance_id,
      node_id: "backend-api-node-1",
      context: {
        organization_id: ORGANIZATION_ID,
        actor_user_id: "system",
        trigger: "message",
      },
      backend_request: {
        method: "GET",
        path: `/api/v1/conversations/${ingress.conversation_id}/messages`,
      },
    });

    assert.equal(callback.accepted, true);
    assert.equal(callback.state.status, "callback_recorded");
    assert.equal(fbp.getMetrics().backend_api_callback_total, 1);
  });
});
