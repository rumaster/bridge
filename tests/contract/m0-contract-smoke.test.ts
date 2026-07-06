import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNotificationTriggerEvent,
  validateNotificationCreatedEvent,
} from "../../packages/contracts/src/c10.js";
import { createEdgeTunnelMessage } from "../../packages/contracts/src/c9.js";
import {
  M0_CONTRACT_REGISTRY,
  validateM0ContractRegistry,
} from "../../packages/contracts/src/registry.js";
import { createAiPlatformServer } from "../../services/ai-platform/src/server.js";
import { createBroadcastPlatformServer } from "../../services/broadcast-platform/src/server.js";
import { createEdgeGatewayServer } from "../../services/edge-gateway/src/server.js";
import { createFbpEngineServer } from "../../services/fbp-engine/src/server.js";
import { createIntegrationPlatformServer } from "../../services/integration-platform/src/server.js";
import {
  createDeliveryEngine,
  createMockExternalChannel,
} from "../../services/integration-platform/src/delivery/index.js";
import { createMobileApiServer } from "../../services/mobile-api/src/server.js";
import { createNotificationPlatformServer } from "../../services/notification-platform/src/server.js";

const fixedNow = () => "2026-07-02T16:30:00.000Z";
const JSON_HEADERS = { "content-type": "application/json" };

const canonicalMessage = Object.freeze({
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  conversation_id: "32345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  channel: "web_chat",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 42,
  type: "text",
  content: {
    text: "ping",
  },
  status: "received",
  created_at: fixedNow(),
  updated_at: fixedNow(),
});

describe("M0 integration contract gate", () => {
  it("has a valid registry for every M0 contract required by issue #24", () => {
    const validation = validateM0ContractRegistry();

    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.deepEqual(
      M0_CONTRACT_REGISTRY.map((contract) => contract.id),
      [
        "C1",
        "C2",
        "C3.auth",
        "C3.base",
        "C4",
        "C5",
        "C6",
        "C7",
        "C8",
        "C9",
        "C10",
        "MOBILE.v1",
      ],
    );
  });

  it("starts the Integration Platform mock and accepts a valid C2 egress delivery", async () => {
    const deliveryEngine = createDeliveryEngine({
      backendClient: {
        async recordAttempt() {
          return { recorded: true };
        },
      },
      channel: createMockExternalChannel(),
    });

    await withServer(createIntegrationPlatformServer({ deliveryEngine }), async (baseUrl) => {
      await assertHealth(baseUrl, "integration-platform");

      const response = await fetchJson(`${baseUrl}/internal/delivery/dispatch`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contract: "C2.EgressDelivery",
          version: "1.0.0",
          idempotency_key: "message-1",
          channel_id: "web-chat-channel",
          message: {
            message_id: "message-1",
            organization_id: "org-1",
            channel_id: "web-chat-channel",
            channel_type: "web_chat",
            conversation_ref: "web-chat-session-1",
            direction: "outbound",
            content: {
              type: "text",
              text: "Здравствуйте",
            },
            occurred_at: fixedNow(),
          },
        }),
      });

      assert.equal(response.statusCode, 202);
      assert.equal(response.body.delivered, true);
      assert.equal(response.body.duplicate, false);
    });
  });

  it("starts the AI Platform mock and validates a C4 assistant request", async () => {
    await withServer(createAiPlatformServer({ now: fixedNow }), async (baseUrl) => {
      await assertHealth(baseUrl, "ai-platform");

      const response = await fetchJson(`${baseUrl}/api/v1/ai/assistant:suggest`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contract: "C4.AssistantSuggestRequest",
          version: "1.0.0",
          request_id: "req-ai-smoke-1",
          organization_id: "org-1",
          conversation_id: "conversation-1",
          requester_user_id: "manager-1",
          query: "Как оформить возврат?",
          context: {
            messages: [],
          },
        }),
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.contract, "C4.AssistantSuggestResponse");
      assert.equal(response.body.degraded, false);
    });
  });

  it("starts the FBP Engine mock and validates a C5 workflow start request", async () => {
    await withServer(createFbpEngineServer({ now: fixedNow }), async (baseUrl) => {
      await assertHealth(baseUrl, "fbp-engine");

      const response = await fetchJson(
        `${baseUrl}/api/v1/workflows/workflow-1/instances`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            contract: "C5.StartWorkflowInstanceRequest",
            version: "1.0.0",
            request_id: "req-fbp-smoke-1",
            organization_id: "org-1",
            workflow_version_id: "workflow-version-1",
            context: {
              organization_id: "org-1",
              actor_user_id: "manager-1",
              trigger: "manual",
            },
          }),
        },
      );

      assert.equal(response.statusCode, 201);
      assert.equal(response.body.contract, "C5.StartWorkflowInstanceResponse");
      assert.equal(response.body.status, "started");
    });
  });

  it("starts the Broadcast Platform mock and validates a C8 start request", async () => {
    await withServer(createBroadcastPlatformServer({ now: fixedNow }), async (baseUrl) => {
      await assertHealth(baseUrl, "broadcast-platform");

      const response = await fetchJson(
        `${baseUrl}/api/v1/broadcasts/broadcast-1:start`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            contract: "C8.StartBroadcastRequest",
            version: "1.0.0",
            request_id: "req-broadcast-smoke-1",
            organization_id: "org-1",
            started_by: "manager-1",
            mode: "immediate",
          }),
        },
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.contract, "C8.StartBroadcastResponse");
      assert.equal(response.body.core_delivery_draft.delivery_path, "C1/C2");
    });
  });

  it("starts the Notification Platform mock and validates a C10 producer trigger", async () => {
    await withServer(
      createNotificationPlatformServer({ now: fixedNow }),
      async (baseUrl) => {
        await assertHealth(baseUrl, "notification-platform");

        const trigger = createNotificationTriggerEvent({
          eventId: "core-message-1:notif",
          producerServiceId: "SVC-CORE",
          producerEventId: "message-1:created",
          organizationId: "org-1",
          recipientUserId: "manager-1",
          category: "critical",
          title: "New priority message",
          body: "Client sent a priority message.",
          payload: {
            conversation_id: "conversation-1",
            message_id: "message-1",
          },
          dedupeKey: "SVC-CORE:message-1:manager-1",
          occurredAt: fixedNow(),
        });
        const response = await fetchJson(
          `${baseUrl}/api/v1/internal/notifications/events`,
          {
            method: "POST",
            headers: {
              ...JSON_HEADERS,
              "x-bridge-organization-id": "org-1",
              "x-bridge-user-id": "manager-1",
            },
            body: JSON.stringify(trigger),
          },
        );

        assert.equal(response.statusCode, 202);
        assert.equal(response.body.contract, "C10.AcceptNotificationTriggerResponse");
        assert.equal(
          validateNotificationCreatedEvent(response.body.notification_created_event).valid,
          true,
        );
      },
    );
  });

  it("starts the Edge Gateway mock and validates a C9 tunnel message", async () => {
    await withServer(createEdgeGatewayServer({ now: fixedNow }), async (baseUrl) => {
      await assertHealth(baseUrl, "edge-gateway");

      const tunnelMessage = createEdgeTunnelMessage({
        payload: canonicalMessage,
        receivedAt: fixedNow(),
        bufferedAt: fixedNow(),
        forwardedAt: fixedNow(),
      });
      const response = await fetchJson(
        `${baseUrl}/api/v1/internal/edge/tunnel/messages`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(tunnelMessage),
        },
      );

      assert.equal(response.statusCode, 202);
      assert.equal(response.body.accepted, true);
      assert.equal(response.body.idempotency_key, canonicalMessage.idempotency_key);
    });
  });

  it("starts the Mobile API mock and validates a MOBILE.v1 device registration", async () => {
    await withServer(createMobileApiServer({ now: fixedNow }), async (baseUrl) => {
      await assertHealth(baseUrl, "mobile-api");

      const response = await fetchJson(`${baseUrl}/mobile/v1/devices`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contract: "MOBILE.RegisterDeviceRequest",
          version: "1.0.0",
          request_id: "req-mobile-device-1",
          organization_id: "org-1",
          user_id: "manager-1",
          device_id: "device-1",
          platform: "android",
          push_provider: "fcm",
          push_token: "fcm-token-1",
        }),
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.body.contract, "MOBILE.RegisterDeviceResponse");
      assert.equal(response.body.push_payload_stub.contract, "MOBILE.PushPayloadStub");
    });
  });
});

async function assertHealth(baseUrl, service) {
  const response = await fetchJson(`${baseUrl}/health`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, service);
}

async function withServer(server, callback) {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function fetchJson(url, init?) {
  const response = await fetch(url, init);

  return {
    statusCode: response.status,
    body: (await response.json()) as any,
  };
}
