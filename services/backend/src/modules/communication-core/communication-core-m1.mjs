import { createHash, randomUUID } from "node:crypto";

import {
  MESSAGE_DIRECTION,
  MESSAGE_SENDER_TYPE,
  MESSAGE_STATUS,
  assertMessageStatusTransition,
  validateCanonicalMessage,
} from "../../../../../packages/contracts/message-model/index.mjs";
import { createWebSocketEvent } from "../../../../../packages/contracts/src/c7.mjs";

const C2_VERSION = "1.0.0";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_CHANNELS = new Set([
  "telegram",
  "max",
  "vk",
  "whatsapp",
  "web_chat",
  "email",
  "sms",
]);
const VALID_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "file",
  "audio",
  "video",
  "location",
  "command",
  "event",
  "system",
]);
const AUTO_IDENTITY_LINK_TYPES = new Set(["verified_phone", "verified_email", "link_code"]);
const CLIENT_STATUS_VALUES = new Set(["anonymous", "identified", "offline", "online"]);
const OUTBOX_EVENT_STATUS = Object.freeze({
  PENDING: "pending",
  PUBLISHED: "published",
  FAILED: "failed",
});
const OUTBOX_EVENT_ORDER = new Map([
  ["conversation.created", 1],
  ["message.created", 2],
  ["message.status_changed", 3],
]);

export class CommunicationCoreM1ValidationError extends Error {
  constructor(message, errors = [message]) {
    super(message);
    this.name = "CommunicationCoreM1ValidationError";
    this.errors = errors;
    this.status = 400;
  }
}

export class CommunicationCoreM1NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommunicationCoreM1NotFoundError";
    this.status = 404;
  }
}

export function assertStatusTransition(fromStatus, toStatus) {
  return assertMessageStatusTransition(fromStatus, toStatus);
}

export function createInMemoryC7EventPublisher({
  clock = () => new Date().toISOString(),
} = {}) {
  const events = [];
  const sequenceNumbers = new Map();

  return {
    async publish(event) {
      const organizationId = event.organizationId ?? event.organization_id;
      const nextSequenceNumber = (sequenceNumbers.get(organizationId) ?? 0) + 1;
      sequenceNumbers.set(organizationId, nextSequenceNumber);

      const envelope = event.contract
        ? event
        : createWebSocketEvent({
            event: event.event,
            eventId: event.eventId ?? randomUUID(),
            organizationId,
            payload: event.payload ?? {},
            sequenceNumber: event.sequenceNumber ?? nextSequenceNumber,
            occurredAt: event.occurredAt ?? clock(),
            subscriptionId: event.subscriptionId,
          });

      events.push(structuredClone(envelope));
      return envelope;
    },

    getEvents() {
      return events.map((event) => structuredClone(event));
    },
  };
}

function createNoopC7EventPublisher() {
  return {
    async publish() {},
  };
}

export function createCommunicationCoreM1Service({
  store = new InMemoryCommunicationCoreStore(),
  clock = () => new Date().toISOString(),
  egressAdapter = createMockC2EgressAdapter({ clock }),
  realtimePublisher = createNoopC7EventPublisher(),
} = {}) {
  async function publishRealtime(event) {
    if (!realtimePublisher || typeof realtimePublisher.publish !== "function") {
      return;
    }

    await realtimePublisher.publish({
      occurredAt: clock(),
      ...event,
    });
  }

  return {
    async acceptIngressMessage(payload) {
      const ingress = normalizeIngressPayload(payload, clock);
      assertInboundCanBeRouted(ingress.message);

      const result = await store.recordInboundMessage(ingress);
      if (!result.duplicate) {
        await publishRealtime(messageCreatedEvent(result.message));
        await publishRealtime(messageStatusChangedEvent({
          message: result.message,
          previousStatus: MESSAGE_STATUS.RECEIVED,
        }));
      }

      return {
        accepted: true,
        duplicate: result.duplicate,
        message_id: result.message.id,
        idempotency_key: ingress.idempotencyKey,
        organization_id: result.message.organization_id,
        client_id: result.endpoint.client_id,
        conversation_id: result.conversation.id,
        endpoint_id: result.endpoint.id,
        sequence_number: result.message.sequence_number,
        sequence_gap: result.sequenceGap ?? null,
        status: result.message.status,
        routed_to: "manager",
        received_at: result.message.created_at,
        routed_at: result.routedAt,
      };
    },

    async handoffEgressMessage(message, target) {
      const normalized = normalizeLegacyEgressPayload(message, target);
      const delivery = buildC2EgressDelivery({
        message: normalized,
        endpoint: {
          metadata: {
            channel_id: target.adapter_endpoint_id,
          },
          external_id: target.adapter_endpoint_id,
        },
      });
      const deliveryResult = await egressAdapter.deliver(delivery);

      return {
        accepted: deliveryResult.accepted !== false,
        mock_delivery: true,
        message_id: normalized.id,
        idempotency_key: normalized.id,
        organization_id: normalized.organization_id,
        endpoint_id: normalized.endpoint_id,
        channel: normalized.channel,
        sequence_number: normalized.sequence_number,
        adapter: target.adapter,
        adapter_endpoint_id: target.adapter_endpoint_id,
        delivery_status: deliveryResult.status ?? MESSAGE_STATUS.SENT,
        sent_at: clock(),
      };
    },

    async listConversations({ organizationId, limit = 50 } = {}) {
      assertUuid(organizationId, "organization_id");

      const data = await store.listConversations({
        organizationId,
        limit: normalizeLimit(limit),
      });

      return {
        data,
        pagination: {
          count: data.length,
          limit: normalizeLimit(limit),
        },
      };
    },

    async listConversationMessages({ organizationId, conversationId, limit = 50 } = {}) {
      assertUuid(organizationId, "organization_id");
      assertUuid(conversationId, "conversation_id");

      const data = await store.listConversationMessages({
        organizationId,
        conversationId,
        limit: normalizeLimit(limit),
      });

      return {
        conversation_id: conversationId,
        data,
        pagination: {
          count: data.length,
          limit: normalizeLimit(limit),
        },
      };
    },

    async sendManagerMessage(payload) {
      const outbound = normalizeOutboundPayload(payload, clock);
      const prepared = await store.prepareOutboundMessage(outbound);

      if (prepared.duplicate) {
        return outboundResponse({
          duplicate: true,
          message: prepared.message,
          conversation: prepared.conversation,
          endpoint: prepared.endpoint,
          deliveryAttempt: prepared.deliveryAttempt,
        });
      }
      await publishRealtime(messageCreatedEvent(prepared.message));

      const delivery = buildC2EgressDelivery({
        message: prepared.message,
        endpoint: prepared.endpoint,
      });

      let deliveryResult;
      try {
        deliveryResult = await egressAdapter.deliver(delivery);
      } catch (error) {
        deliveryResult = {
          accepted: false,
          status: MESSAGE_STATUS.FAILED,
          error: error.message,
        };
      }

      const deliveryStatus =
        deliveryResult.accepted === false ? MESSAGE_STATUS.FAILED : MESSAGE_STATUS.SENT;

      const delivered = await store.recordDeliveryAttemptAndTransition({
        organizationId: outbound.organizationId,
        messageId: prepared.message.id,
        adapter: "web_chat",
        attemptNo: prepared.nextAttemptNo,
        status: deliveryStatus,
        error: deliveryResult.error ?? null,
        occurredAt: clock(),
      });
      await publishRealtime(messageStatusChangedEvent({
        message: delivered.message,
        previousStatus: MESSAGE_STATUS.ROUTED,
      }));

      return outboundResponse({
        duplicate: false,
        message: delivered.message,
        conversation: delivered.conversation,
        endpoint: prepared.endpoint,
        deliveryAttempt: delivered.deliveryAttempt,
      });
    },

    async mergeClients(payload) {
      const result = await store.mergeClients({
        actorType: "user",
        occurredAt: clock(),
        ...payload,
      });
      await publishRealtime({
        event: "client.status_changed",
        organizationId: payload.organizationId,
        payload: {
          client_id: payload.targetClientId,
          merged_source_client_id: payload.sourceClientId,
          status: "identified",
        },
      });

      return result;
    },

    async revertIdentityLink(payload) {
      const result = await store.revertIdentityLink({
        actorType: "user",
        occurredAt: clock(),
        ...payload,
      });
      await publishRealtime({
        event: "client.status_changed",
        organizationId: payload.organizationId,
        payload: {
          client_id: result.previous_client_id,
          reverted_link_id: result.reverted_link.id,
          status: "identified",
        },
      });

      return result;
    },

    async detectSequenceGaps(payload) {
      return store.detectSequenceGaps(payload);
    },

    async publishTypingEvent(payload) {
      const event = payload.typing === false ? "typing.stopped" : "typing.started";
      await publishRealtime({
        event,
        organizationId: payload.organizationId,
        payload: {
          actor_type: payload.actorType,
          conversation_id: payload.conversationId,
          endpoint_id: payload.endpointId,
        },
      });

      return { published: true, event };
    },

    async publishClientStatusChanged(payload) {
      if (!CLIENT_STATUS_VALUES.has(payload.status)) {
        throw new CommunicationCoreM1ValidationError(`Unsupported client status: ${payload.status}`);
      }

      await publishRealtime({
        event: "client.status_changed",
        organizationId: payload.organizationId,
        payload: {
          client_id: payload.clientId,
          status: payload.status,
        },
      });

      return { published: true, event: "client.status_changed" };
    },

    async selectDeliveryChannel(payload) {
      return store.selectDeliveryChannel(payload);
    },

    async publishOutboxEvents({ organizationId, publisher, limit = 50 } = {}) {
      assertUuid(organizationId, "organization_id");
      const publish = normalizeOutboxPublisher(publisher);
      const events = await store.listPendingOutboxEvents({
        organizationId,
        limit: normalizeLimit(limit),
      });
      const deliveries = [];
      let publishedCount = 0;
      let failedCount = 0;

      for (const event of events) {
        try {
          const result = await publish(event);
          if (result?.accepted === false) {
            throw new Error(result.error ?? "Outbox publisher rejected event.");
          }
          await store.markOutboxEventPublished({
            eventId: event.id,
            organizationId,
            publishedAt: clock(),
          });
          deliveries.push({
            event_id: event.id,
            event_type: event.event_type,
            result,
          });
          publishedCount += 1;
        } catch (error) {
          await store.markOutboxEventFailed({
            eventId: event.id,
            organizationId,
          });
          deliveries.push({
            event_id: event.id,
            event_type: event.event_type,
            error: error.message,
          });
          failedCount += 1;
        }
      }

      return {
        published_count: publishedCount,
        failed_count: failedCount,
        deliveries,
      };
    },
  };
}

function outboundResponse({
  duplicate,
  message,
  conversation,
  endpoint,
  deliveryAttempt,
}) {
  return {
    accepted: true,
    duplicate,
    message_id: message.id,
    idempotency_key: message.id,
    organization_id: message.organization_id,
    conversation_id: conversation.id,
    endpoint_id: endpoint.id,
    sequence_number: message.sequence_number,
    status: message.status,
    delivery_attempt: deliveryAttempt
      ? {
          adapter: deliveryAttempt.adapter,
          attempt_no: deliveryAttempt.attempt_no,
          status: deliveryAttempt.status,
          error: deliveryAttempt.error,
        }
      : null,
  };
}

function messageCreatedEvent(message) {
  return {
    event: "message.created",
    organizationId: message.organization_id,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      endpoint_id: message.endpoint_id,
      client_id: message.client_id,
      direction: message.direction,
      sequence_number: message.sequence_number,
      status: message.status,
    },
    occurredAt: message.created_at,
  };
}

function messageStatusChangedEvent({ message, previousStatus }) {
  return {
    event: "message.status_changed",
    organizationId: message.organization_id,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      endpoint_id: message.endpoint_id,
      previous_status: previousStatus,
      status: message.status,
    },
  };
}

export function createMockC2EgressAdapter({ clock = () => new Date().toISOString() } = {}) {
  const deliveries = [];

  return {
    async deliver(delivery) {
      deliveries.push(structuredClone(delivery));
      return {
        accepted: true,
        duplicate: false,
        status: MESSAGE_STATUS.SENT,
        accepted_at: clock(),
      };
    },

    getDeliveries() {
      return deliveries.map((delivery) => structuredClone(delivery));
    },
  };
}

export function createHttpC2EgressAdapter({
  url,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("url is required for HTTP C2 egress adapter");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return {
    async deliver(delivery) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(delivery),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.accepted === false) {
        return {
          accepted: false,
          status: MESSAGE_STATUS.FAILED,
          error: body.errors?.join("; ") ?? `HTTP ${response.status}`,
        };
      }

      return {
        accepted: true,
        duplicate: body.duplicate === true,
        status: MESSAGE_STATUS.SENT,
        body,
      };
    },
  };
}

export function createFbpWorkflowOutboxPublisher({
  fbp,
  workflowId,
  workflowVersionId,
  actorUserId = "system",
} = {}) {
  if (!fbp) {
    throw new TypeError("fbp is required for outbox publisher");
  }
  if (typeof workflowId !== "string" || workflowId.trim() === "") {
    throw new TypeError("workflowId is required for outbox publisher");
  }
  if (typeof workflowVersionId !== "string" || workflowVersionId.trim() === "") {
    throw new TypeError("workflowVersionId is required for outbox publisher");
  }

  const deliveredEventIds = new Set();

  return {
    async publish(event) {
      if (deliveredEventIds.has(event.id)) {
        return {
          accepted: true,
          duplicate: true,
          event_id: event.id,
        };
      }

      const response = await publishOutboxEventToFbp({
        actorUserId,
        event,
        fbp,
        workflowId,
        workflowVersionId,
      });
      deliveredEventIds.add(event.id);

      return {
        accepted: response?.degraded !== true,
        duplicate: false,
        event_id: event.id,
        response,
      };
    },
  };
}

async function publishOutboxEventToFbp({
  actorUserId,
  event,
  fbp,
  workflowId,
  workflowVersionId,
}) {
  if (typeof fbp.startWorkflowInstance === "function") {
    return fbp.startWorkflowInstance({
      request_id: event.id,
      organization_id: event.organization_id,
      workflow_id: workflowId,
      workflow_version_id: workflowVersionId,
      actor_user_id: actorUserId,
      input: {
        outbox_event: event,
      },
    });
  }

  const request = {
    contract: "C5.StartWorkflowInstanceRequest",
    version: "1.0.0",
    request_id: event.id,
    organization_id: event.organization_id,
    workflow_version_id: workflowVersionId,
    input: {
      outbox_event: event,
    },
    context: {
      organization_id: event.organization_id,
      actor_user_id: actorUserId,
      trigger: "message",
      correlation_id: event.id,
    },
  };

  if (typeof fbp.startWorkflow === "function") {
    return fbp.startWorkflow(workflowId, request);
  }
  if (typeof fbp === "function") {
    return fbp(request);
  }

  throw new TypeError("fbp must be a function or expose startWorkflow/startWorkflowInstance");
}

function createConversationCreatedOutboxEvent(conversation) {
  return createOutboxDomainEvent({
    aggregateType: "conversation",
    aggregateId: conversation.id,
    eventType: "conversation.created",
    organizationId: conversation.organization_id,
    occurredAt: conversation.created_at,
    payload: {
      client_id: conversation.client_id,
      status: conversation.status,
      created_at: conversation.created_at,
    },
  });
}

function createMessageCreatedOutboxEvent(message, { clientId = null } = {}) {
  return createOutboxDomainEvent({
    aggregateType: "message",
    aggregateId: message.id,
    eventType: "message.created",
    organizationId: message.organization_id,
    occurredAt: message.created_at,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      endpoint_id: message.endpoint_id,
      client_id: message.client_id ?? clientId,
      channel: message.channel,
      direction: message.direction,
      sender_type: message.sender_type,
      sequence_number: message.sequence_number,
      type: message.type,
      status: message.status,
      occurred_at: message.created_at,
    },
  });
}

function createMessageStatusChangedOutboxEvent({
  message,
  previousStatus,
  occurredAt,
}) {
  return createOutboxDomainEvent({
    aggregateType: "message",
    aggregateId: message.id,
    eventType: "message.status_changed",
    organizationId: message.organization_id,
    occurredAt,
    dedupeKey: `${previousStatus}->${message.status}`,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      endpoint_id: message.endpoint_id,
      previous_status: previousStatus,
      status: message.status,
      occurred_at: occurredAt,
    },
  });
}

function createOutboxDomainEvent({
  aggregateType,
  aggregateId,
  eventType,
  organizationId,
  occurredAt,
  payload,
  dedupeKey = "created",
}) {
  return {
    id: uuidFromText(
      `outbox:${organizationId}:${aggregateType}:${aggregateId}:${eventType}:${dedupeKey}`,
    ),
    organization_id: organizationId,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    event_type: eventType,
    payload: {
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      organization_id: organizationId,
      ...payload,
    },
    status: OUTBOX_EVENT_STATUS.PENDING,
    created_at: normalizeTimestamp(occurredAt),
    published_at: null,
  };
}

export class InMemoryCommunicationCoreStore {
  constructor() {
    this.clients = new Map();
    this.endpoints = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.attachments = new Map();
    this.deliveryAttempts = new Map();
    this.identityLinks = new Map();
    this.channels = new Map();
    this.outboxEvents = new Map();
    this.broadcasts = new Map();
    this.broadcastMessages = new Map();
  }

  async recordInboundMessage(ingress) {
    const existing = this.messages.get(messageKey(ingress.organizationId, ingress.message.id));
    if (existing) {
      return this.resultForExistingMessage(ingress.organizationId, existing);
    }

    const endpoint = this.resolveEndpoint(ingress);
    const conversationResolution = this.resolveConversationWithCreated({
      organizationId: ingress.organizationId,
      clientId: endpoint.client_id,
      conversationId: ingress.conversationId,
      conversationRef: ingress.conversationRef,
      occurredAt: ingress.occurredAt,
    });
    const { conversation } = conversationResolution;
    const sequenceNumber =
      ingress.message.sequence_number ?? this.nextSequenceNumber(ingress.organizationId, endpoint.id);
    const sequenceGap =
      ingress.message.sequence_number == null
        ? null
        : this.sequenceGapForInsert({
            organizationId: ingress.organizationId,
            endpointId: endpoint.id,
            receivedSequenceNumber: ingress.message.sequence_number,
          });
    const received = {
      ...ingress.message,
      client_id: endpoint.client_id,
      conversation_id: conversation.id,
      endpoint_id: endpoint.id,
      sequence_number: sequenceNumber,
      status: MESSAGE_STATUS.RECEIVED,
    };

    const routedAt = ingress.routedAt;
    const routed = transitionStoredMessage(received, MESSAGE_STATUS.ROUTED, routedAt);
    this.messages.set(messageKey(ingress.organizationId, routed.id), routed);
    this.attachments.set(
      messageKey(ingress.organizationId, routed.id),
      ingress.attachments.map((attachment) => ({
        ...attachment,
        organization_id: ingress.organizationId,
        message_id: routed.id,
      })),
    );
    this.updateConversationLastMessage(conversation, routed.created_at, routedAt);
    this.appendOutboxEvents([
      ...(conversationResolution.created
        ? [createConversationCreatedOutboxEvent(conversation)]
        : []),
      createMessageCreatedOutboxEvent(received, {
        clientId: endpoint.client_id,
      }),
      createMessageStatusChangedOutboxEvent({
        message: routed,
        previousStatus: MESSAGE_STATUS.RECEIVED,
        occurredAt: routedAt,
      }),
    ]);

    return {
      duplicate: false,
      message: clone(routed),
      conversation: clone(conversation),
      endpoint: clone(endpoint),
      sequenceGap,
      routedAt,
    };
  }

  async prepareOutboundMessage(outbound) {
    const existing = this.messages.get(messageKey(outbound.organizationId, outbound.message.id));
    if (existing) {
      return this.resultForExistingMessage(outbound.organizationId, existing);
    }

    const conversation = this.conversations.get(
      conversationKey(outbound.organizationId, outbound.conversationId),
    );
    if (!conversation) {
      throw new CommunicationCoreM1NotFoundError("Conversation was not found.");
    }

    const endpoint = this.findEndpointForClient(
      outbound.organizationId,
      conversation.client_id,
      outbound.endpointId,
    );
    if (!endpoint) {
      throw new CommunicationCoreM1NotFoundError("Communication endpoint was not found.");
    }

    const message = {
      ...outbound.message,
      organization_id: outbound.organizationId,
      client_id: endpoint.client_id,
      conversation_id: conversation.id,
      endpoint_id: endpoint.id,
      channel: endpoint.channel,
      sequence_number: this.nextSequenceNumber(outbound.organizationId, endpoint.id),
      status: MESSAGE_STATUS.ROUTED,
    };

    this.messages.set(messageKey(outbound.organizationId, message.id), message);
    this.attachments.set(messageKey(outbound.organizationId, message.id), []);
    this.updateConversationLastMessage(conversation, message.created_at, message.created_at);
    this.appendOutboxEvents([
      createMessageCreatedOutboxEvent(message, {
        clientId: endpoint.client_id,
      }),
    ]);

    return {
      duplicate: false,
      message: clone(message),
      conversation: clone(conversation),
      endpoint: clone(endpoint),
      nextAttemptNo: 1,
    };
  }

  async recordDeliveryAttemptAndTransition({
    organizationId,
    messageId,
    adapter,
    attemptNo,
    status,
    error,
    occurredAt,
  }) {
    const key = messageKey(organizationId, messageId);
    const message = this.messages.get(key);
    if (!message) {
      throw new CommunicationCoreM1NotFoundError("Message was not found.");
    }

    const nextMessageStatus =
      status === MESSAGE_STATUS.SENT ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED;
    const transitioned = transitionStoredMessage(message, nextMessageStatus, occurredAt);
    this.messages.set(key, transitioned);
    this.appendOutboxEvents([
      createMessageStatusChangedOutboxEvent({
        message: transitioned,
        previousStatus: message.status,
        occurredAt,
      }),
    ]);

    const attempt = {
      id: randomUUID(),
      organization_id: organizationId,
      message_id: messageId,
      adapter,
      attempt_no: attemptNo,
      status,
      error,
      created_at: occurredAt,
    };
    const attempts = this.deliveryAttempts.get(key) ?? [];
    attempts.push(attempt);
    this.deliveryAttempts.set(key, attempts);

    return {
      message: clone(transitioned),
      conversation: clone(
        this.conversations.get(conversationKey(organizationId, transitioned.conversation_id)),
      ),
      deliveryAttempt: clone(attempt),
    };
  }

  async recordDeliveryAttempt({
    organizationId,
    messageId,
    adapter,
    attemptNo,
    status,
    error,
    occurredAt,
  }) {
    const key = messageKey(organizationId, messageId);
    const message = this.messages.get(key);
    if (!message) {
      throw new CommunicationCoreM1NotFoundError("Message was not found.");
    }

    const attempt = {
      id: uuidFromText(
        `${organizationId}:delivery_attempt:${messageId}:${adapter}:${attemptNo}`,
      ),
      organization_id: organizationId,
      message_id: messageId,
      adapter,
      attempt_no: attemptNo,
      status,
      error: error ?? null,
      created_at: occurredAt,
    };
    const attempts = this.deliveryAttempts.get(key) ?? [];
    const existingIndex = attempts.findIndex(
      (item) => item.adapter === adapter && item.attempt_no === attemptNo,
    );
    if (existingIndex >= 0) {
      attempts[existingIndex] = attempt;
    } else {
      attempts.push(attempt);
    }
    this.deliveryAttempts.set(key, attempts);

    return { deliveryAttempt: clone(attempt) };
  }

  async recordBroadcastDelivery({
    organizationId,
    broadcastId,
    broadcastName,
    draft,
    occurredAt,
  }) {
    const source = draft.message;
    const existing = this.messages.get(messageKey(organizationId, source.id));
    if (existing) {
      const link = this.broadcastMessages.get(
        broadcastMessageKey(organizationId, broadcastId, source.id),
      );
      const attempts = this.deliveryAttempts.get(messageKey(organizationId, source.id)) ?? [];

      return {
        duplicate: true,
        message: clone(existing),
        conversation: clone(
          this.conversations.get(conversationKey(organizationId, existing.conversation_id)),
        ),
        endpoint: clone(
          this.endpoints.get(endpointKey(organizationId, existing.endpoint_id)),
        ),
        broadcastMessage: clone(link ?? null),
        nextAttemptNo: attempts.length + 1,
      };
    }

    const conversation = this.conversations.get(
      conversationKey(organizationId, source.conversation_id),
    );
    if (!conversation) {
      throw new CommunicationCoreM1NotFoundError("Conversation was not found.");
    }

    const endpoint = this.endpoints.get(endpointKey(organizationId, source.endpoint_id));
    if (!endpoint) {
      throw new CommunicationCoreM1NotFoundError("Communication endpoint was not found.");
    }

    this.ensureBroadcast({
      organizationId,
      broadcastId,
      name: broadcastName,
      occurredAt,
    });

    const stored = {
      ...source,
      organization_id: organizationId,
      client_id: endpoint.client_id,
      conversation_id: conversation.id,
      endpoint_id: endpoint.id,
      channel: endpoint.channel,
      direction: MESSAGE_DIRECTION.OUTBOUND,
      sender_type: "broadcast",
      sequence_number: this.nextSequenceNumber(organizationId, endpoint.id),
      status: MESSAGE_STATUS.ROUTED,
      created_at: source.created_at ?? occurredAt,
    };

    this.messages.set(messageKey(organizationId, stored.id), stored);
    this.attachments.set(messageKey(organizationId, stored.id), []);
    this.updateConversationLastMessage(conversation, stored.created_at, occurredAt);

    const link = {
      id: uuidFromText(`${organizationId}:broadcast_message:${broadcastId}:${stored.id}`),
      organization_id: organizationId,
      broadcast_id: broadcastId,
      message_id: stored.id,
      status: "prepared",
      created_at: occurredAt,
      updated_at: occurredAt,
    };
    this.broadcastMessages.set(
      broadcastMessageKey(organizationId, broadcastId, stored.id),
      link,
    );

    this.appendOutboxEvents([
      createMessageCreatedOutboxEvent(stored, { clientId: endpoint.client_id }),
    ]);

    return {
      duplicate: false,
      message: clone(stored),
      conversation: clone(conversation),
      endpoint: clone(endpoint),
      broadcastMessage: clone(link),
      nextAttemptNo: 1,
    };
  }

  async updateBroadcastMessageStatus({
    organizationId,
    broadcastId,
    messageId,
    status,
    occurredAt,
  }) {
    const key = broadcastMessageKey(organizationId, broadcastId, messageId);
    const link = this.broadcastMessages.get(key);
    if (!link) {
      throw new CommunicationCoreM1NotFoundError("Broadcast message link was not found.");
    }

    link.status = status;
    link.updated_at = occurredAt ?? link.updated_at;
    this.broadcastMessages.set(key, link);

    return clone(link);
  }

  ensureBroadcast({ organizationId, broadcastId, name, occurredAt }) {
    const key = broadcastKey(organizationId, broadcastId);
    if (!this.broadcasts.has(key)) {
      const trimmedName = typeof name === "string" ? name.trim() : "";
      this.broadcasts.set(key, {
        id: broadcastId,
        organization_id: organizationId,
        name: trimmedName === "" ? `Broadcast ${broadcastId}` : name,
        status: "running",
        created_at: occurredAt,
        updated_at: occurredAt,
      });
    }

    return clone(this.broadcasts.get(key));
  }

  getBroadcasts() {
    return Array.from(this.broadcasts.values()).map(clone);
  }

  getBroadcastMessages() {
    return Array.from(this.broadcastMessages.values()).map(clone);
  }

  async listConversations({ organizationId, limit }) {
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.organization_id === organizationId)
      .sort(compareConversations)
      .slice(0, limit)
      .map(clone);
  }

  async listConversationMessages({ organizationId, conversationId, limit }) {
    const rows = Array.from(this.messages.values())
      .filter(
        (message) =>
          message.organization_id === organizationId &&
          message.conversation_id === conversationId,
      )
      .sort(compareMessages)
      .slice(0, limit);

    return rows.map((message) => ({
      ...clone(message),
      attachments: clone(this.attachments.get(messageKey(organizationId, message.id)) ?? []),
    }));
  }

  getDeliveryAttempts() {
    return Array.from(this.deliveryAttempts.values()).flat().map(clone);
  }

  resultForExistingMessage(organizationId, message) {
    const conversation = this.conversations.get(
      conversationKey(organizationId, message.conversation_id),
    );
    const endpoint = this.endpoints.get(endpointKey(organizationId, message.endpoint_id));
    const attempts = this.deliveryAttempts.get(messageKey(organizationId, message.id)) ?? [];

    return {
      duplicate: true,
      message: clone(message),
      conversation: clone(conversation),
      endpoint: clone(endpoint),
      deliveryAttempt: clone(attempts.at(-1) ?? null),
      routedAt: message.routed_at ?? message.created_at,
    };
  }

  resolveEndpoint(ingress) {
    const existing = Array.from(this.endpoints.values()).find(
      (endpoint) =>
        endpoint.organization_id === ingress.organizationId &&
        endpoint.channel === ingress.channel &&
        endpoint.external_id === ingress.endpointExternalId,
    );

    if (existing) {
      return this.applyVerifiedIdentityToEndpoint(existing, ingress);
    }

    const linkedClientId = this.findClientIdByVerifiedIdentity(
      ingress.organizationId,
      ingress.identity,
    );
    const clientId =
      linkedClientId ??
      ingress.clientId ??
      uuidFromText(
        `${ingress.organizationId}:client:${ingress.channel}:${ingress.endpointExternalId}`,
      );
    const endpointId =
      ingress.endpointId ??
      uuidFromText(
        `${ingress.organizationId}:endpoint:${ingress.channel}:${ingress.endpointExternalId}`,
      );
    const client = {
      id: clientId,
      organization_id: ingress.organizationId,
      display_name: ingress.senderRef ?? "Web Chat Client",
      anonymized_at: null,
      created_at: ingress.occurredAt,
      updated_at: ingress.occurredAt,
    };
    const endpoint = {
      id: endpointId,
      organization_id: ingress.organizationId,
      client_id: clientId,
      channel: ingress.channel,
      external_id: ingress.endpointExternalId,
      verified: false,
      verified_at: null,
      metadata: {
        channel_id: ingress.channelId,
        conversation_ref: ingress.conversationRef,
        identity: ingress.identity?.evidence ?? null,
        sender_ref: ingress.senderRef,
      },
      created_at: ingress.occurredAt,
    };

    if (!this.clients.has(clientKey(ingress.organizationId, clientId))) {
      this.clients.set(clientKey(ingress.organizationId, clientId), client);
    }
    this.endpoints.set(endpointKey(ingress.organizationId, endpointId), endpoint);
    this.ensureVerifiedIdentityLink({
      clientId,
      endpointId,
      identity: ingress.identity,
      occurredAt: ingress.occurredAt,
      organizationId: ingress.organizationId,
    });

    return endpoint;
  }

  applyVerifiedIdentityToEndpoint(endpoint, ingress) {
    const linkedClientId = this.findClientIdByVerifiedIdentity(
      ingress.organizationId,
      ingress.identity,
    );
    if (linkedClientId && linkedClientId !== endpoint.client_id) {
      this.moveEndpointToClient({
        endpointId: endpoint.id,
        organizationId: ingress.organizationId,
        targetClientId: linkedClientId,
        occurredAt: ingress.occurredAt,
      });
      endpoint.client_id = linkedClientId;
    }

    this.ensureVerifiedIdentityLink({
      clientId: endpoint.client_id,
      endpointId: endpoint.id,
      identity: ingress.identity,
      occurredAt: ingress.occurredAt,
      organizationId: ingress.organizationId,
    });

    return endpoint;
  }

  findClientIdByVerifiedIdentity(organizationId, identity) {
    if (!isVerifiedIdentity(identity)) {
      return null;
    }

    const activeLink = Array.from(this.identityLinks.values()).find(
      (link) =>
        link.organization_id === organizationId &&
        link.reverted_at === null &&
        link.link_type === identity.link_type &&
        link.evidence?.identity_value === identity.value,
    );

    return activeLink?.client_id ?? null;
  }

  ensureVerifiedIdentityLink({
    clientId,
    endpointId,
    identity,
    occurredAt,
    organizationId,
  }) {
    if (!isVerifiedIdentity(identity)) {
      return null;
    }

    const activeEndpointLink = Array.from(this.identityLinks.values()).find(
      (link) =>
        link.organization_id === organizationId &&
        link.endpoint_id === endpointId &&
        link.reverted_at === null,
    );
    if (activeEndpointLink) {
      return activeEndpointLink;
    }

    return this.createIdentityLink({
      clientId,
      endpointId,
      linkType: identity.link_type,
      evidence: identity.evidence,
      createdBy: null,
      createdByActorType: "system",
      createdAt: occurredAt,
      organizationId,
    });
  }

  resolveConversation({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    return this.resolveConversationWithCreated({
      organizationId,
      clientId,
      conversationId,
      conversationRef,
      occurredAt,
    }).conversation;
  }

  resolveConversationWithCreated({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    if (conversationId) {
      const existing = this.conversations.get(conversationKey(organizationId, conversationId));
      if (existing) {
        return {
          conversation: existing,
          created: false,
        };
      }
    }

    const openConversation = Array.from(this.conversations.values())
      .filter(
        (conversation) =>
          conversation.organization_id === organizationId &&
          conversation.client_id === clientId &&
          conversation.status !== "closed",
      )
      .sort(compareConversations)[0];

    if (openConversation) {
      return {
        conversation: openConversation,
        created: false,
      };
    }

    const id =
      conversationId ??
      uuidFromText(`${organizationId}:conversation:${clientId}:${conversationRef ?? "default"}`);
    const conversation = {
      id,
      organization_id: organizationId,
      client_id: clientId,
      status: "open",
      last_message_at: null,
      created_at: occurredAt,
      updated_at: occurredAt,
    };
    this.conversations.set(conversationKey(organizationId, id), conversation);

    return {
      conversation,
      created: true,
    };
  }

  findEndpointForClient(organizationId, clientId, endpointId) {
    if (endpointId) {
      const endpoint = this.endpoints.get(endpointKey(organizationId, endpointId));
      if (endpoint && endpoint.client_id === clientId) {
        return endpoint;
      }
    }

    return Array.from(this.endpoints.values()).find(
      (endpoint) =>
        endpoint.organization_id === organizationId && endpoint.client_id === clientId,
    );
  }

  async mergeClients({
    organizationId,
    sourceClientId,
    targetClientId,
    actorUserId = null,
    actorType = "user",
    reason = null,
    occurredAt,
  }) {
    assertUuid(organizationId, "organization_id");
    assertUuid(sourceClientId, "source_client_id");
    assertUuid(targetClientId, "target_client_id");
    if (sourceClientId === targetClientId) {
      throw new CommunicationCoreM1ValidationError("source_client_id and target_client_id must differ.");
    }
    this.requireClient(organizationId, sourceClientId);
    this.requireClient(organizationId, targetClientId);

    const targetConversation = this.resolveConversation({
      organizationId,
      clientId: targetClientId,
      occurredAt,
    });
    const sourceEndpoints = Array.from(this.endpoints.values()).filter(
      (endpoint) =>
        endpoint.organization_id === organizationId &&
        endpoint.client_id === sourceClientId,
    );
    const links = [];
    let movedMessageCount = 0;

    for (const endpoint of sourceEndpoints) {
      const previousConversation = this.findConversationForEndpoint({
        endpointId: endpoint.id,
        organizationId,
        clientId: sourceClientId,
      });
      const link = this.createIdentityLink({
        clientId: targetClientId,
        endpointId: endpoint.id,
        linkType: "manual",
        evidence: {
          previous_client_id: sourceClientId,
          previous_conversation_id: previousConversation?.id ?? null,
          reason,
          target_client_id: targetClientId,
          target_conversation_id: targetConversation.id,
        },
        createdBy: actorUserId,
        createdByActorType: actorType,
        createdAt: occurredAt,
        organizationId,
      });

      endpoint.client_id = targetClientId;
      this.endpoints.set(endpointKey(organizationId, endpoint.id), endpoint);
      for (const message of this.messages.values()) {
        if (
          message.organization_id === organizationId &&
          message.endpoint_id === endpoint.id &&
          message.conversation_id !== targetConversation.id
        ) {
          message.conversation_id = targetConversation.id;
          movedMessageCount += 1;
        }
      }
      if (previousConversation) {
        previousConversation.status = "closed";
        previousConversation.updated_at = occurredAt;
        this.conversations.set(
          conversationKey(organizationId, previousConversation.id),
          previousConversation,
        );
        this.recalculateConversationLastMessage(
          organizationId,
          previousConversation.id,
          occurredAt,
        );
      }
      links.push(link);
    }

    this.recalculateConversationLastMessage(organizationId, targetConversation.id, occurredAt);

    return {
      accepted: true,
      mode: "core-m2",
      sourceClientId,
      targetClientId,
      moved_endpoint_count: sourceEndpoints.length,
      moved_message_count: movedMessageCount,
      links: links.map(clone),
    };
  }

  async revertIdentityLink({
    organizationId,
    linkId,
    actorUserId = null,
    actorType = "user",
    reason,
    occurredAt,
  }) {
    assertUuid(organizationId, "organization_id");
    assertUuid(linkId, "link_id");
    const link = this.identityLinks.get(identityLinkKey(organizationId, linkId));
    if (!link || link.organization_id !== organizationId) {
      throw new CommunicationCoreM1NotFoundError("Identity link was not found.");
    }
    if (link.reverted_at) {
      return {
        reverted: false,
        reverted_link: clone(link),
        previous_client_id: link.evidence?.previous_client_id ?? null,
      };
    }

    const previousClientId = link.evidence?.previous_client_id;
    const previousConversationId = link.evidence?.previous_conversation_id;
    const targetConversationId = link.evidence?.target_conversation_id;
    if (!previousClientId || !previousConversationId || !targetConversationId) {
      throw new CommunicationCoreM1ValidationError(
        "Only reversible manual links with previous conversation evidence can be reverted.",
      );
    }

    const endpoint = this.endpoints.get(endpointKey(organizationId, link.endpoint_id));
    if (!endpoint) {
      throw new CommunicationCoreM1NotFoundError("Communication endpoint was not found.");
    }
    endpoint.client_id = previousClientId;
    this.endpoints.set(endpointKey(organizationId, endpoint.id), endpoint);

    for (const message of this.messages.values()) {
      if (
        message.organization_id === organizationId &&
        message.endpoint_id === endpoint.id &&
        message.conversation_id === targetConversationId
      ) {
        message.conversation_id = previousConversationId;
      }
    }

    const previousConversation = this.conversations.get(
      conversationKey(organizationId, previousConversationId),
    );
    if (previousConversation) {
      previousConversation.status = "open";
      previousConversation.updated_at = occurredAt;
      this.conversations.set(conversationKey(organizationId, previousConversation.id), previousConversation);
      this.recalculateConversationLastMessage(organizationId, previousConversation.id, occurredAt);
    }
    this.recalculateConversationLastMessage(organizationId, targetConversationId, occurredAt);

    link.reverted_at = occurredAt;
    link.reverted_by = actorUserId;
    link.reverted_by_actor_type = actorType;
    link.reverted_reason = reason;
    this.identityLinks.set(identityLinkKey(organizationId, link.id), link);

    return {
      reverted: true,
      reverted_link: clone(link),
      previous_client_id: previousClientId,
    };
  }

  requireClient(organizationId, clientId) {
    const client = this.clients.get(clientKey(organizationId, clientId));
    if (!client) {
      throw new CommunicationCoreM1NotFoundError("Client was not found.");
    }

    return client;
  }

  findConversationForEndpoint({ organizationId, endpointId, clientId }) {
    const message = Array.from(this.messages.values())
      .filter(
        (item) =>
          item.organization_id === organizationId &&
          item.endpoint_id === endpointId,
      )
      .sort(compareMessages)[0];
    if (message) {
      return this.conversations.get(conversationKey(organizationId, message.conversation_id));
    }

    return Array.from(this.conversations.values()).find(
      (conversation) =>
        conversation.organization_id === organizationId &&
        conversation.client_id === clientId &&
        conversation.status !== "closed",
    );
  }

  moveEndpointToClient({ organizationId, endpointId, targetClientId, occurredAt }) {
    const endpoint = this.endpoints.get(endpointKey(organizationId, endpointId));
    if (!endpoint || endpoint.client_id === targetClientId) {
      return;
    }
    const previousConversation = this.findConversationForEndpoint({
      organizationId,
      endpointId,
      clientId: endpoint.client_id,
    });

    const targetConversation = this.resolveConversation({
      organizationId,
      clientId: targetClientId,
      occurredAt,
    });
    endpoint.client_id = targetClientId;
    this.endpoints.set(endpointKey(organizationId, endpointId), endpoint);

    for (const message of this.messages.values()) {
      if (message.organization_id === organizationId && message.endpoint_id === endpointId) {
        message.conversation_id = targetConversation.id;
      }
    }
    if (previousConversation && previousConversation.id !== targetConversation.id) {
      previousConversation.status = "closed";
      previousConversation.updated_at = occurredAt;
      this.conversations.set(
        conversationKey(organizationId, previousConversation.id),
        previousConversation,
      );
      this.recalculateConversationLastMessage(
        organizationId,
        previousConversation.id,
        occurredAt,
      );
    }
    this.recalculateConversationLastMessage(organizationId, targetConversation.id, occurredAt);
  }

  createIdentityLink({
    organizationId,
    clientId,
    endpointId,
    linkType,
    evidence = {},
    createdBy,
    createdByActorType = "system",
    createdAt,
  }) {
    const activeEndpointLink = Array.from(this.identityLinks.values()).find(
      (link) =>
        link.organization_id === organizationId &&
        link.endpoint_id === endpointId &&
        link.reverted_at === null,
    );
    if (activeEndpointLink) {
      activeEndpointLink.reverted_at = createdAt;
      activeEndpointLink.reverted_by = createdBy ?? null;
      activeEndpointLink.reverted_by_actor_type = createdByActorType;
      activeEndpointLink.reverted_reason = "Superseded by a newer identity link.";
    }

    const link = {
      id: randomUUID(),
      organization_id: organizationId,
      client_id: clientId,
      endpoint_id: endpointId,
      link_type: linkType,
      evidence,
      created_by: createdBy ?? null,
      created_by_actor_type: createdByActorType,
      created_at: createdAt,
      reverted_at: null,
      reverted_by: null,
      reverted_by_actor_type: null,
      reverted_reason: null,
    };
    this.identityLinks.set(identityLinkKey(organizationId, link.id), link);

    return link;
  }

  getIdentityLinks() {
    return Array.from(this.identityLinks.values()).map(clone);
  }

  appendOutboxEvents(events) {
    for (const event of events) {
      if (!this.outboxEvents.has(outboxEventKey(event.organization_id, event.id))) {
        this.outboxEvents.set(outboxEventKey(event.organization_id, event.id), clone(event));
      }
    }
  }

  getOutboxEvents() {
    return Array.from(this.outboxEvents.values())
      .sort(compareOutboxEvents)
      .map(clone);
  }

  async listPendingOutboxEvents({ organizationId, limit = 50 }) {
    return Array.from(this.outboxEvents.values())
      .filter(
        (event) =>
          event.organization_id === organizationId &&
          event.status === OUTBOX_EVENT_STATUS.PENDING,
      )
      .sort(compareOutboxEvents)
      .slice(0, limit)
      .map(clone);
  }

  async markOutboxEventPublished({ organizationId, eventId, publishedAt }) {
    const key = outboxEventKey(organizationId, eventId);
    const event = this.outboxEvents.get(key);
    if (!event) {
      throw new CommunicationCoreM1NotFoundError("Outbox event was not found.");
    }
    if (event.status === OUTBOX_EVENT_STATUS.PUBLISHED) {
      return clone(event);
    }

    event.status = OUTBOX_EVENT_STATUS.PUBLISHED;
    event.published_at = publishedAt;
    this.outboxEvents.set(key, event);

    return clone(event);
  }

  async markOutboxEventFailed({ organizationId, eventId }) {
    const key = outboxEventKey(organizationId, eventId);
    const event = this.outboxEvents.get(key);
    if (!event) {
      throw new CommunicationCoreM1NotFoundError("Outbox event was not found.");
    }
    if (event.status !== OUTBOX_EVENT_STATUS.PUBLISHED) {
      event.status = OUTBOX_EVENT_STATUS.FAILED;
      event.published_at = null;
      this.outboxEvents.set(key, event);
    }

    return clone(event);
  }

  sequenceGapForInsert({ organizationId, endpointId, receivedSequenceNumber }) {
    const missing = this.detectMissingSequences(organizationId, endpointId);
    const expected = missing[0] ?? this.nextSequenceNumber(organizationId, endpointId);

    if (receivedSequenceNumber > expected) {
      return {
        endpoint_id: endpointId,
        expected_sequence_number: expected,
        received_sequence_number: receivedSequenceNumber,
      };
    }

    return null;
  }

  async detectSequenceGaps({ organizationId, endpointId }) {
    assertUuid(organizationId, "organization_id");
    assertUuid(endpointId, "endpoint_id");
    const sequences = this.sequencesForEndpoint(organizationId, endpointId);
    const gaps = [];

    for (let index = 0; index < sequences.length - 1; index += 1) {
      const current = sequences[index];
      const next = sequences[index + 1];
      if (next > current + 1) {
        gaps.push({
          after_sequence_number: current,
          expected_sequence_number: current + 1,
          received_sequence_number: next,
        });
      }
    }

    return gaps;
  }

  detectMissingSequences(organizationId, endpointId) {
    const sequences = this.sequencesForEndpoint(organizationId, endpointId);
    const missing = [];
    for (let expected = 1; expected <= Math.max(0, ...sequences); expected += 1) {
      if (!sequences.includes(expected)) {
        missing.push(expected);
      }
    }

    return missing;
  }

  sequencesForEndpoint(organizationId, endpointId) {
    return Array.from(this.messages.values())
      .filter(
        (message) =>
          message.organization_id === organizationId && message.endpoint_id === endpointId,
      )
      .map((message) => message.sequence_number)
      .sort((left, right) => left - right);
  }

  upsertChannelCapabilities({
    organizationId,
    channelId,
    channelType,
    capabilities,
    status = "connected",
  }) {
    this.channels.set(channelKey(organizationId, channelId), {
      organization_id: organizationId,
      channel_id: channelId,
      channel_type: channelType,
      capabilities: { ...capabilities },
      status,
    });
  }

  async selectDeliveryChannel({ organizationId, requiredCapabilities }) {
    const selected = Array.from(this.channels.values()).find(
      (channel) =>
        channel.organization_id === organizationId &&
        channel.status === "connected" &&
        requiredCapabilities.every((capability) => channel.capabilities[capability] === true),
    );

    if (!selected) {
      throw new CommunicationCoreM1NotFoundError("Delivery channel with required capabilities was not found.");
    }

    return clone(selected);
  }

  nextSequenceNumber(organizationId, endpointId) {
    return (
      Math.max(
        0,
        ...Array.from(this.messages.values())
          .filter(
            (message) =>
              message.organization_id === organizationId && message.endpoint_id === endpointId,
          )
          .map((message) => message.sequence_number),
      ) + 1
    );
  }

  updateConversationLastMessage(conversation, lastMessageAt, updatedAt) {
    conversation.last_message_at = lastMessageAt;
    conversation.updated_at = updatedAt;
    this.conversations.set(conversationKey(conversation.organization_id, conversation.id), conversation);
  }

  recalculateConversationLastMessage(organizationId, conversationId, updatedAt) {
    const conversation = this.conversations.get(conversationKey(organizationId, conversationId));
    if (!conversation) {
      return;
    }

    const lastMessage = Array.from(this.messages.values())
      .filter(
        (message) =>
          message.organization_id === organizationId &&
          message.conversation_id === conversationId,
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    conversation.last_message_at = lastMessage?.created_at ?? null;
    conversation.updated_at = updatedAt;
    this.conversations.set(conversationKey(organizationId, conversationId), conversation);
  }
}

export function createPostgresCommunicationCoreStore({ client }) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("client with query(sql, params) is required");
  }

  async function withTenantTransaction(organizationId, callback) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.is_platform_operator', 'false', true)");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [
        organizationId,
      ]);
      const result = await callback();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async function getMessageWithContext(organizationId, messageId) {
    const messageResult = await client.query(
      `
        SELECT *
        FROM messages
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, messageId],
    );

    if (messageResult.rowCount === 0) {
      return null;
    }

    return rowToMessage(messageResult.rows[0]);
  }

  async function resultForExistingMessage(organizationId, message) {
    const conversation = await getConversationById(organizationId, message.conversation_id);
    const endpoint = await getEndpointById(organizationId, message.endpoint_id);
    const attempts = await getDeliveryAttempts(organizationId, message.id);

    return {
      duplicate: true,
      message,
      conversation,
      endpoint,
      deliveryAttempt: attempts.at(-1) ?? null,
      routedAt: message.routed_at ?? message.created_at,
    };
  }

  async function applyVerifiedIdentityToEndpoint(endpoint, ingress) {
    const linkedClientId = await findClientIdByVerifiedIdentity(
      ingress.organizationId,
      ingress.identity,
    );
    if (linkedClientId && linkedClientId !== endpoint.client_id) {
      await moveEndpointToClient({
        endpointId: endpoint.id,
        organizationId: ingress.organizationId,
        targetClientId: linkedClientId,
        occurredAt: ingress.occurredAt,
      });
      endpoint.client_id = linkedClientId;
    }

    await ensureVerifiedIdentityLink({
      clientId: endpoint.client_id,
      endpointId: endpoint.id,
      identity: ingress.identity,
      occurredAt: ingress.occurredAt,
      organizationId: ingress.organizationId,
    });

    return endpoint;
  }

  async function findClientIdByVerifiedIdentity(organizationId, identity) {
    if (!isVerifiedIdentity(identity)) {
      return null;
    }

    const result = await client.query(
      `
        SELECT client_id
        FROM client_identity_links
        WHERE organization_id = $1
          AND link_type = $2
          AND evidence ->> 'identity_value' = $3
          AND reverted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [organizationId, identity.link_type, identity.value],
    );

    return result.rowCount === 0 ? null : result.rows[0].client_id;
  }

  async function ensureVerifiedIdentityLink({
    clientId,
    endpointId,
    identity,
    occurredAt,
    organizationId,
  }) {
    if (!isVerifiedIdentity(identity)) {
      return null;
    }

    const existing = await client.query(
      `
        SELECT *
        FROM client_identity_links
        WHERE organization_id = $1
          AND endpoint_id = $2
          AND reverted_at IS NULL
        LIMIT 1
      `,
      [organizationId, endpointId],
    );
    if (existing.rowCount > 0) {
      return rowToIdentityLink(existing.rows[0]);
    }

    return createIdentityLink({
      clientId,
      endpointId,
      linkType: identity.link_type,
      evidence: identity.evidence,
      createdBy: null,
      createdByActorType: "system",
      createdAt: occurredAt,
      organizationId,
    });
  }

  async function createIdentityLink({
    organizationId,
    clientId,
    endpointId,
    linkType,
    evidence,
    createdBy,
    createdByActorType,
    createdAt,
  }) {
    await client.query(
      `
        UPDATE client_identity_links
        SET reverted_at = $4::timestamptz,
            reverted_by = $5,
            reverted_by_actor_type = $6,
            reverted_reason = 'Superseded by a newer identity link.'
        WHERE organization_id = $1
          AND endpoint_id = $2
          AND reverted_at IS NULL
          AND link_type <> $3
      `,
      [organizationId, endpointId, linkType, createdAt, createdBy ?? null, createdByActorType],
    );
    const result = await client.query(
      `
        INSERT INTO client_identity_links (
          id,
          organization_id,
          client_id,
          endpoint_id,
          link_type,
          evidence,
          created_by,
          created_by_actor_type,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz)
        RETURNING *
      `,
      [
        randomUUID(),
        organizationId,
        clientId,
        endpointId,
        linkType,
        JSON.stringify(evidence ?? {}),
        createdBy ?? null,
        createdByActorType,
        createdAt,
      ],
    );

    return rowToIdentityLink(result.rows[0]);
  }

  async function moveEndpointToClient({
    organizationId,
    endpointId,
    targetClientId,
    occurredAt,
  }) {
    const endpoint = await getEndpointById(organizationId, endpointId);
    if (!endpoint || endpoint.client_id === targetClientId) {
      return;
    }
    const previousConversation = await findConversationForEndpoint({
      organizationId,
      endpointId,
      clientId: endpoint.client_id,
    });
    const targetConversation = await resolveConversation({
      organizationId,
      clientId: targetClientId,
      occurredAt,
    });
    await client.query(
      `
        UPDATE communication_endpoints
        SET client_id = $3
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, endpointId, targetClientId],
    );
    await client.query(
      `
        UPDATE messages
        SET conversation_id = $3
        WHERE organization_id = $1
          AND endpoint_id = $2
      `,
      [organizationId, endpointId, targetConversation.id],
    );
    if (previousConversation && previousConversation.id !== targetConversation.id) {
      await client.query(
        `
          UPDATE conversations
          SET status = 'closed',
              updated_at = $3::timestamptz
          WHERE organization_id = $1
            AND id = $2
        `,
        [organizationId, previousConversation.id, occurredAt],
      );
      await recalculateConversationLastMessage(
        organizationId,
        previousConversation.id,
        occurredAt,
      );
    }
    await recalculateConversationLastMessage(
      organizationId,
      targetConversation.id,
      occurredAt,
    );
  }

  async function resolveEndpoint(ingress) {
    const existing = await client.query(
      `
        SELECT *
        FROM communication_endpoints
        WHERE organization_id = $1
          AND channel = $2
          AND external_id = $3
        LIMIT 1
      `,
      [ingress.organizationId, ingress.channel, ingress.endpointExternalId],
    );

    if (existing.rowCount > 0) {
      return applyVerifiedIdentityToEndpoint(rowToEndpoint(existing.rows[0]), ingress);
    }

    const linkedClientId = await findClientIdByVerifiedIdentity(
      ingress.organizationId,
      ingress.identity,
    );
    const clientId =
      linkedClientId ??
      ingress.clientId ??
      uuidFromText(
        `${ingress.organizationId}:client:${ingress.channel}:${ingress.endpointExternalId}`,
      );
    const endpointId =
      ingress.endpointId ??
      uuidFromText(
        `${ingress.organizationId}:endpoint:${ingress.channel}:${ingress.endpointExternalId}`,
      );

    await client.query(
      `
        INSERT INTO clients (
          id,
          organization_id,
          display_name,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        clientId,
        ingress.organizationId,
        ingress.senderRef ?? "Web Chat Client",
        ingress.occurredAt,
      ],
    );

    const metadata = {
      channel_id: ingress.channelId,
      conversation_ref: ingress.conversationRef,
      identity: ingress.identity?.evidence ?? null,
      sender_ref: ingress.senderRef,
    };

    const created = await client.query(
      `
        INSERT INTO communication_endpoints (
          id,
          organization_id,
          client_id,
          channel,
          external_id,
          verified,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, false, $6::jsonb, $7::timestamptz)
        ON CONFLICT (organization_id, channel, external_id) DO UPDATE SET
          metadata = communication_endpoints.metadata || EXCLUDED.metadata
        RETURNING *
      `,
      [
        endpointId,
        ingress.organizationId,
        clientId,
        ingress.channel,
        ingress.endpointExternalId,
        JSON.stringify(metadata),
        ingress.occurredAt,
      ],
    );

    const endpoint = rowToEndpoint(created.rows[0]);
    await ensureVerifiedIdentityLink({
      clientId,
      endpointId: endpoint.id,
      identity: ingress.identity,
      occurredAt: ingress.occurredAt,
      organizationId: ingress.organizationId,
    });

    return endpoint;
  }

  async function resolveConversation({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    const result = await resolveConversationWithCreated({
      organizationId,
      clientId,
      conversationId,
      conversationRef,
      occurredAt,
    });

    return result.conversation;
  }

  async function resolveConversationWithCreated({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    if (conversationId) {
      const existing = await getConversationById(organizationId, conversationId);
      if (existing) {
        return {
          conversation: existing,
          created: false,
        };
      }
    }

    const open = await client.query(
      `
        SELECT *
        FROM conversations
        WHERE organization_id = $1
          AND client_id = $2
          AND status <> 'closed'
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [organizationId, clientId],
    );

    if (open.rowCount > 0) {
      return {
        conversation: rowToConversation(open.rows[0]),
        created: false,
      };
    }

    const id =
      conversationId ??
      uuidFromText(`${organizationId}:conversation:${clientId}:${conversationRef ?? "default"}`);

    const created = await client.query(
      `
        INSERT INTO conversations (
          id,
          organization_id,
          client_id,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'open', $4::timestamptz, $4::timestamptz)
        RETURNING *
      `,
      [id, organizationId, clientId, occurredAt],
    );

    return {
      conversation: rowToConversation(created.rows[0]),
      created: true,
    };
  }

  async function nextSequenceNumber(organizationId, endpointId) {
    const result = await client.query(
      `
        SELECT COALESCE(MAX(sequence_number), 0)::int + 1 AS next_sequence_number
        FROM messages
        WHERE organization_id = $1
          AND endpoint_id = $2
      `,
      [organizationId, endpointId],
    );

    return result.rows[0].next_sequence_number;
  }

  async function lockEndpointPartition(organizationId, endpointId) {
    await client.query(
      `
        SELECT id
        FROM communication_endpoints
        WHERE organization_id = $1
          AND id = $2
        FOR UPDATE
      `,
      [organizationId, endpointId],
    );
  }

  async function sequenceGapForInsert({
    organizationId,
    endpointId,
    receivedSequenceNumber,
  }) {
    const missing = await detectMissingSequences(organizationId, endpointId);
    const expected = missing[0] ?? Number(await nextSequenceNumber(organizationId, endpointId));

    if (receivedSequenceNumber > expected) {
      return {
        endpoint_id: endpointId,
        expected_sequence_number: expected,
        received_sequence_number: receivedSequenceNumber,
      };
    }

    return null;
  }

  async function detectMissingSequences(organizationId, endpointId) {
    const sequences = await sequencesForEndpoint(organizationId, endpointId);
    const missing = [];
    for (let expected = 1; expected <= Math.max(0, ...sequences); expected += 1) {
      if (!sequences.includes(expected)) {
        missing.push(expected);
      }
    }

    return missing;
  }

  async function sequencesForEndpoint(organizationId, endpointId) {
    const result = await client.query(
      `
        SELECT sequence_number
        FROM messages
        WHERE organization_id = $1
          AND endpoint_id = $2
        ORDER BY sequence_number ASC
      `,
      [organizationId, endpointId],
    );

    return result.rows.map((row) => Number(row.sequence_number));
  }

  async function getConversationById(organizationId, conversationId) {
    const result = await client.query(
      `
        SELECT *
        FROM conversations
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, conversationId],
    );

    return result.rowCount === 0 ? null : rowToConversation(result.rows[0]);
  }

  async function getEndpointById(organizationId, endpointId) {
    const result = await client.query(
      `
        SELECT *
        FROM communication_endpoints
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, endpointId],
    );

    return result.rowCount === 0 ? null : rowToEndpoint(result.rows[0]);
  }

  async function getDeliveryAttempts(organizationId, messageId) {
    const result = await client.query(
      `
        SELECT *
        FROM message_delivery_attempts
        WHERE organization_id = $1
          AND message_id = $2
        ORDER BY attempt_no
      `,
      [organizationId, messageId],
    );

    return result.rows.map(rowToDeliveryAttempt);
  }

  async function getBroadcastMessageLink(organizationId, broadcastId, messageId) {
    const result = await client.query(
      `
        SELECT *
        FROM broadcast_messages
        WHERE organization_id = $1
          AND broadcast_id = $2
          AND message_id = $3
      `,
      [organizationId, broadcastId, messageId],
    );

    return result.rowCount === 0 ? null : rowToBroadcastMessage(result.rows[0]);
  }

  async function ensureBroadcastRow({ organizationId, broadcastId, name, occurredAt }) {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const resolvedName = trimmedName === "" ? `Broadcast ${broadcastId}` : name;
    await client.query(
      `
        INSERT INTO broadcasts (id, organization_id, name, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'running', $4::timestamptz, $4::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [broadcastId, organizationId, resolvedName, occurredAt],
    );
  }

  async function getOutboxEventById(organizationId, eventId) {
    const result = await client.query(
      `
        SELECT *
        FROM outbox_events
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, eventId],
    );

    if (result.rowCount === 0) {
      throw new CommunicationCoreM1NotFoundError("Outbox event was not found.");
    }

    return rowToOutboxEvent(result.rows[0]);
  }

  async function insertOutboxEvents(events) {
    for (const event of events) {
      await client.query(
        `
          INSERT INTO outbox_events (
            id,
            organization_id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload,
            status,
            created_at,
            published_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          event.id,
          event.organization_id,
          event.aggregate_type,
          event.aggregate_id,
          event.event_type,
          JSON.stringify(event.payload),
          event.status,
          event.created_at,
          event.published_at,
        ],
      );
    }
  }

  return {
    async recordInboundMessage(ingress) {
      return withTenantTransaction(ingress.organizationId, async () => {
        const existing = await getMessageWithContext(ingress.organizationId, ingress.message.id);
        if (existing) {
          return resultForExistingMessage(ingress.organizationId, existing);
        }

        const endpoint = await resolveEndpoint(ingress);
        await lockEndpointPartition(ingress.organizationId, endpoint.id);
        const conversationResolution = await resolveConversationWithCreated({
          organizationId: ingress.organizationId,
          clientId: endpoint.client_id,
          conversationId: ingress.conversationId,
          conversationRef: ingress.conversationRef,
          occurredAt: ingress.occurredAt,
        });
        const { conversation } = conversationResolution;
        const sequenceNumber =
          ingress.message.sequence_number ??
          (await nextSequenceNumber(ingress.organizationId, endpoint.id));
        const sequenceGap =
          ingress.message.sequence_number == null
            ? null
            : await sequenceGapForInsert({
                organizationId: ingress.organizationId,
                endpointId: endpoint.id,
                receivedSequenceNumber: ingress.message.sequence_number,
              });
        const routedAt = ingress.routedAt;
        const receivedMessage = {
          ...ingress.message,
          client_id: endpoint.client_id,
          conversation_id: conversation.id,
          endpoint_id: endpoint.id,
          sequence_number: sequenceNumber,
          status: MESSAGE_STATUS.RECEIVED,
        };

        await client.query(
          `
            INSERT INTO messages (
              id,
              organization_id,
              conversation_id,
              endpoint_id,
              channel,
              direction,
              sender_type,
              sequence_number,
              type,
              content,
              status,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              'inbound',
              'client',
              $6,
              $7,
              $8::jsonb,
              'received',
              $9::timestamptz
            )
          `,
          [
            ingress.message.id,
            ingress.organizationId,
            conversation.id,
            endpoint.id,
            ingress.channel,
            sequenceNumber,
            ingress.message.type,
            JSON.stringify(ingress.message.content),
            ingress.occurredAt,
          ],
        );

        for (const attachment of ingress.attachments) {
          await client.query(
            `
              INSERT INTO attachments (
                id,
                organization_id,
                message_id,
                kind,
                storage_ref,
                mime,
                size,
                metadata,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
            `,
            [
              attachment.id,
              ingress.organizationId,
              ingress.message.id,
              attachment.kind,
              attachment.storage_ref,
              attachment.mime,
              attachment.size,
              JSON.stringify(attachment.metadata ?? {}),
              ingress.occurredAt,
            ],
          );
        }

        await client.query(
          `
            UPDATE messages
            SET status = 'routed'
            WHERE organization_id = $1
              AND id = $2
          `,
          [ingress.organizationId, ingress.message.id],
        );
        await client.query(
          `
            UPDATE conversations
            SET last_message_at = $1::timestamptz,
                updated_at = $2::timestamptz
            WHERE organization_id = $3
              AND id = $4
          `,
          [ingress.occurredAt, routedAt, ingress.organizationId, conversation.id],
        );

        const message = await getMessageWithContext(
          ingress.organizationId,
          ingress.message.id,
        );
        await insertOutboxEvents([
          ...(conversationResolution.created
            ? [createConversationCreatedOutboxEvent(conversation)]
            : []),
          createMessageCreatedOutboxEvent(receivedMessage, {
            clientId: endpoint.client_id,
          }),
          createMessageStatusChangedOutboxEvent({
            message,
            previousStatus: MESSAGE_STATUS.RECEIVED,
            occurredAt: routedAt,
          }),
        ]);
        const updatedConversation = await getConversationById(
          ingress.organizationId,
          conversation.id,
        );

        return {
          duplicate: false,
          message,
          conversation: updatedConversation,
          endpoint,
          sequenceGap,
          routedAt,
        };
      });
    },

    async prepareOutboundMessage(outbound) {
      return withTenantTransaction(outbound.organizationId, async () => {
        const existing = await getMessageWithContext(
          outbound.organizationId,
          outbound.message.id,
        );
        if (existing) {
          return resultForExistingMessage(outbound.organizationId, existing);
        }

        const conversation = await getConversationById(
          outbound.organizationId,
          outbound.conversationId,
        );
        if (!conversation) {
          throw new CommunicationCoreM1NotFoundError("Conversation was not found.");
        }

        const endpoint = await findEndpointForClient({
          organizationId: outbound.organizationId,
          clientId: conversation.client_id,
          endpointId: outbound.endpointId,
        });
        if (!endpoint) {
          throw new CommunicationCoreM1NotFoundError("Communication endpoint was not found.");
        }

        await lockEndpointPartition(outbound.organizationId, endpoint.id);
        const sequenceNumber = await nextSequenceNumber(outbound.organizationId, endpoint.id);

        await client.query(
          `
            INSERT INTO messages (
              id,
              organization_id,
              conversation_id,
              endpoint_id,
              channel,
              direction,
              sender_type,
              sequence_number,
              type,
              content,
              status,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              'outbound',
              $6,
              $7,
              $8,
              $9::jsonb,
              'routed',
              $10::timestamptz
            )
          `,
          [
            outbound.message.id,
            outbound.organizationId,
            conversation.id,
            endpoint.id,
            endpoint.channel,
            outbound.message.sender_type,
            sequenceNumber,
            outbound.message.type,
            JSON.stringify(outbound.message.content),
            outbound.message.created_at,
          ],
        );
        await client.query(
          `
            UPDATE conversations
            SET last_message_at = $1::timestamptz,
                updated_at = $1::timestamptz
            WHERE organization_id = $2
              AND id = $3
          `,
          [outbound.message.created_at, outbound.organizationId, conversation.id],
        );

        const message = await getMessageWithContext(
          outbound.organizationId,
          outbound.message.id,
        );
        await insertOutboxEvents([
          createMessageCreatedOutboxEvent(message, {
            clientId: endpoint.client_id,
          }),
        ]);
        const updatedConversation = await getConversationById(
          outbound.organizationId,
          conversation.id,
        );

        return {
          duplicate: false,
          message,
          conversation: updatedConversation,
          endpoint,
          nextAttemptNo: 1,
        };
      });
    },

    async recordDeliveryAttemptAndTransition({
      organizationId,
      messageId,
      adapter,
      attemptNo,
      status,
      error,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        const current = await getMessageWithContext(organizationId, messageId);
        if (!current) {
          throw new CommunicationCoreM1NotFoundError("Message was not found.");
        }

        const nextMessageStatus =
          status === MESSAGE_STATUS.SENT ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED;
        if (!assertStatusTransition(current.status, nextMessageStatus)) {
          throw new CommunicationCoreM1ValidationError(
            `Invalid status transition: ${current.status} -> ${nextMessageStatus}`,
          );
        }

        await client.query(
          `
            UPDATE messages
            SET status = $1,
                delivered_at = CASE WHEN $1 = 'delivered' THEN $2::timestamptz ELSE delivered_at END
            WHERE organization_id = $3
              AND id = $4
          `,
          [nextMessageStatus, occurredAt, organizationId, messageId],
        );
        const attemptId = uuidFromText(
          `${organizationId}:delivery_attempt:${messageId}:${adapter}:${attemptNo}`,
        );
        const attempt = await client.query(
          `
            INSERT INTO message_delivery_attempts (
              id,
              organization_id,
              message_id,
              adapter,
              attempt_no,
              status,
              error,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
            ON CONFLICT (message_id, adapter, attempt_no) DO UPDATE SET
              status = EXCLUDED.status,
              error = EXCLUDED.error
            RETURNING *
          `,
          [
            attemptId,
            organizationId,
            messageId,
            adapter,
            attemptNo,
            status,
            error,
            occurredAt,
          ],
        );

        const message = await getMessageWithContext(organizationId, messageId);
        await insertOutboxEvents([
          createMessageStatusChangedOutboxEvent({
            message,
            previousStatus: current.status,
            occurredAt,
          }),
        ]);
        const conversation = await getConversationById(organizationId, message.conversation_id);

        return {
          message,
          conversation,
          deliveryAttempt: rowToDeliveryAttempt(attempt.rows[0]),
        };
      });
    },

    async recordDeliveryAttempt({
      organizationId,
      messageId,
      adapter,
      attemptNo,
      status,
      error,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        const current = await getMessageWithContext(organizationId, messageId);
        if (!current) {
          throw new CommunicationCoreM1NotFoundError("Message was not found.");
        }

        const attemptId = uuidFromText(
          `${organizationId}:delivery_attempt:${messageId}:${adapter}:${attemptNo}`,
        );
        const attempt = await client.query(
          `
            INSERT INTO message_delivery_attempts (
              id,
              organization_id,
              message_id,
              adapter,
              attempt_no,
              status,
              error,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
            ON CONFLICT (message_id, adapter, attempt_no) DO UPDATE SET
              status = EXCLUDED.status,
              error = EXCLUDED.error
            RETURNING *
          `,
          [
            attemptId,
            organizationId,
            messageId,
            adapter,
            attemptNo,
            status,
            error ?? null,
            occurredAt,
          ],
        );

        return {
          deliveryAttempt: rowToDeliveryAttempt(attempt.rows[0]),
        };
      });
    },

    async recordBroadcastDelivery({
      organizationId,
      broadcastId,
      broadcastName,
      draft,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        const source = draft.message;
        const existing = await getMessageWithContext(organizationId, source.id);
        if (existing) {
          const link = await getBroadcastMessageLink(organizationId, broadcastId, source.id);
          const attempts = await getDeliveryAttempts(organizationId, source.id);
          const conversation = await getConversationById(
            organizationId,
            existing.conversation_id,
          );
          const endpoint = await getEndpointById(organizationId, existing.endpoint_id);

          return {
            duplicate: true,
            message: existing,
            conversation,
            endpoint,
            broadcastMessage: link,
            nextAttemptNo: attempts.length + 1,
          };
        }

        const conversation = await getConversationById(
          organizationId,
          source.conversation_id,
        );
        if (!conversation) {
          throw new CommunicationCoreM1NotFoundError("Conversation was not found.");
        }

        const endpoint = await getEndpointById(organizationId, source.endpoint_id);
        if (!endpoint) {
          throw new CommunicationCoreM1NotFoundError("Communication endpoint was not found.");
        }

        await ensureBroadcastRow({
          organizationId,
          broadcastId,
          name: broadcastName,
          occurredAt,
        });
        await lockEndpointPartition(organizationId, endpoint.id);
        const sequenceNumber = await nextSequenceNumber(organizationId, endpoint.id);

        await client.query(
          `
            INSERT INTO messages (
              id,
              organization_id,
              conversation_id,
              endpoint_id,
              channel,
              direction,
              sender_type,
              sequence_number,
              type,
              content,
              status,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              'outbound',
              'broadcast',
              $6,
              $7,
              $8::jsonb,
              'routed',
              $9::timestamptz
            )
          `,
          [
            source.id,
            organizationId,
            conversation.id,
            endpoint.id,
            endpoint.channel,
            sequenceNumber,
            source.type,
            JSON.stringify(source.content),
            source.created_at ?? occurredAt,
          ],
        );
        await client.query(
          `
            UPDATE conversations
            SET last_message_at = $1::timestamptz,
                updated_at = $2::timestamptz
            WHERE organization_id = $3
              AND id = $4
          `,
          [source.created_at ?? occurredAt, occurredAt, organizationId, conversation.id],
        );

        const linkId = uuidFromText(
          `${organizationId}:broadcast_message:${broadcastId}:${source.id}`,
        );
        const linkResult = await client.query(
          `
            INSERT INTO broadcast_messages (
              id,
              organization_id,
              broadcast_id,
              message_id,
              status,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, 'prepared', $5::timestamptz, $5::timestamptz)
            ON CONFLICT (organization_id, broadcast_id, message_id) DO NOTHING
            RETURNING *
          `,
          [linkId, organizationId, broadcastId, source.id, occurredAt],
        );

        const message = await getMessageWithContext(organizationId, source.id);
        await insertOutboxEvents([
          createMessageCreatedOutboxEvent(message, {
            clientId: endpoint.client_id,
          }),
        ]);
        const updatedConversation = await getConversationById(
          organizationId,
          conversation.id,
        );
        const link =
          linkResult.rowCount > 0
            ? rowToBroadcastMessage(linkResult.rows[0])
            : await getBroadcastMessageLink(organizationId, broadcastId, source.id);

        return {
          duplicate: false,
          message,
          conversation: updatedConversation,
          endpoint,
          broadcastMessage: link,
          nextAttemptNo: 1,
        };
      });
    },

    async updateBroadcastMessageStatus({
      organizationId,
      broadcastId,
      messageId,
      status,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            UPDATE broadcast_messages
            SET status = $1,
                updated_at = GREATEST($2::timestamptz, updated_at)
            WHERE organization_id = $3
              AND broadcast_id = $4
              AND message_id = $5
            RETURNING *
          `,
          [status, occurredAt, organizationId, broadcastId, messageId],
        );
        if (result.rowCount === 0) {
          throw new CommunicationCoreM1NotFoundError("Broadcast message link was not found.");
        }

        return rowToBroadcastMessage(result.rows[0]);
      });
    },

    async listConversations({ organizationId, limit }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            SELECT *
            FROM conversations
            WHERE organization_id = $1
            ORDER BY last_message_at DESC NULLS LAST, created_at DESC
            LIMIT $2
          `,
          [organizationId, limit],
        );

        return result.rows.map(rowToConversation);
      });
    },

    async listConversationMessages({ organizationId, conversationId, limit }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            SELECT *
            FROM messages
            WHERE organization_id = $1
              AND conversation_id = $2
            ORDER BY sequence_number ASC, created_at ASC
            LIMIT $3
          `,
          [organizationId, conversationId, limit],
        );

        const rows = [];
        for (const row of result.rows) {
          const attachments = await client.query(
            `
              SELECT *
              FROM attachments
              WHERE organization_id = $1
                AND message_id = $2
              ORDER BY created_at ASC
            `,
            [organizationId, row.id],
          );
          rows.push({
            ...rowToMessage(row),
            attachments: attachments.rows.map(rowToAttachment),
          });
        }

        return rows;
      });
    },

    async listPendingOutboxEvents({ organizationId, limit = 50 }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            SELECT *
            FROM outbox_events
            WHERE organization_id = $1
              AND status = 'pending'
            ORDER BY
              created_at ASC,
              CASE event_type
                WHEN 'conversation.created' THEN 1
                WHEN 'message.created' THEN 2
                WHEN 'message.status_changed' THEN 3
                ELSE 100
              END ASC,
              id ASC
            LIMIT $2
          `,
          [organizationId, limit],
        );

        return result.rows.map(rowToOutboxEvent);
      });
    },

    async markOutboxEventPublished({ organizationId, eventId, publishedAt }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            UPDATE outbox_events
            SET status = 'published',
                published_at = $3::timestamptz
            WHERE organization_id = $1
              AND id = $2
              AND status <> 'published'
            RETURNING *
          `,
          [organizationId, eventId, publishedAt],
        );

        return result.rowCount === 0
          ? getOutboxEventById(organizationId, eventId)
          : rowToOutboxEvent(result.rows[0]);
      });
    },

    async markOutboxEventFailed({ organizationId, eventId }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            UPDATE outbox_events
            SET status = 'failed',
                published_at = NULL
            WHERE organization_id = $1
              AND id = $2
              AND status <> 'published'
            RETURNING *
          `,
          [organizationId, eventId],
        );

        return result.rowCount === 0
          ? getOutboxEventById(organizationId, eventId)
          : rowToOutboxEvent(result.rows[0]);
      });
    },

    async mergeClients({
      organizationId,
      sourceClientId,
      targetClientId,
      actorUserId = null,
      actorType = "user",
      reason = null,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        if (sourceClientId === targetClientId) {
          throw new CommunicationCoreM1ValidationError(
            "source_client_id and target_client_id must differ.",
          );
        }
        await requireClient(organizationId, sourceClientId);
        await requireClient(organizationId, targetClientId);

        const targetConversation = await resolveConversation({
          organizationId,
          clientId: targetClientId,
          occurredAt,
        });
        const endpoints = await client.query(
          `
            SELECT *
            FROM communication_endpoints
            WHERE organization_id = $1
              AND client_id = $2
            ORDER BY created_at ASC
            FOR UPDATE
          `,
          [organizationId, sourceClientId],
        );
        const links = [];
        let movedMessageCount = 0;

        for (const endpointRow of endpoints.rows) {
          const endpoint = rowToEndpoint(endpointRow);
          const previousConversation = await findConversationForEndpoint({
            clientId: sourceClientId,
            endpointId: endpoint.id,
            organizationId,
          });
          const link = await createIdentityLink({
            clientId: targetClientId,
            endpointId: endpoint.id,
            linkType: "manual",
            evidence: {
              previous_client_id: sourceClientId,
              previous_conversation_id: previousConversation?.id ?? null,
              reason,
              target_client_id: targetClientId,
              target_conversation_id: targetConversation.id,
            },
            createdBy: actorUserId,
            createdByActorType: actorType,
            createdAt: occurredAt,
            organizationId,
          });
          links.push(link);

          await client.query(
            `
              UPDATE communication_endpoints
              SET client_id = $3
              WHERE organization_id = $1
                AND id = $2
            `,
            [organizationId, endpoint.id, targetClientId],
          );
          const moved = await client.query(
            `
              UPDATE messages
              SET conversation_id = $3
              WHERE organization_id = $1
                AND endpoint_id = $2
                AND conversation_id <> $3
            `,
            [organizationId, endpoint.id, targetConversation.id],
          );
          movedMessageCount += moved.rowCount ?? 0;
          if (previousConversation) {
            await client.query(
              `
                UPDATE conversations
                SET status = 'closed',
                    updated_at = $3::timestamptz
                WHERE organization_id = $1
                  AND id = $2
              `,
              [organizationId, previousConversation.id, occurredAt],
            );
            await recalculateConversationLastMessage(
              organizationId,
              previousConversation.id,
              occurredAt,
            );
          }
        }

        await recalculateConversationLastMessage(
          organizationId,
          targetConversation.id,
          occurredAt,
        );

        return {
          accepted: true,
          mode: "core-m2",
          sourceClientId,
          targetClientId,
          moved_endpoint_count: endpoints.rowCount,
          moved_message_count: movedMessageCount,
          links,
        };
      });
    },

    async revertIdentityLink({
      organizationId,
      linkId,
      actorUserId = null,
      actorType = "user",
      reason,
      occurredAt,
    }) {
      return withTenantTransaction(organizationId, async () => {
        const linkResult = await client.query(
          `
            SELECT *
            FROM client_identity_links
            WHERE organization_id = $1
              AND id = $2
            FOR UPDATE
          `,
          [organizationId, linkId],
        );
        if (linkResult.rowCount === 0) {
          throw new CommunicationCoreM1NotFoundError("Identity link was not found.");
        }
        const link = rowToIdentityLink(linkResult.rows[0]);
        if (link.reverted_at) {
          return {
            reverted: false,
            reverted_link: link,
            previous_client_id: link.evidence?.previous_client_id ?? null,
          };
        }

        const previousClientId = link.evidence?.previous_client_id;
        const previousConversationId = link.evidence?.previous_conversation_id;
        const targetConversationId = link.evidence?.target_conversation_id;
        if (!previousClientId || !previousConversationId || !targetConversationId) {
          throw new CommunicationCoreM1ValidationError(
            "Only reversible manual links with previous conversation evidence can be reverted.",
          );
        }

        await client.query(
          `
            UPDATE communication_endpoints
            SET client_id = $3
            WHERE organization_id = $1
              AND id = $2
          `,
          [organizationId, link.endpoint_id, previousClientId],
        );
        await client.query(
          `
            UPDATE messages
            SET conversation_id = $4
            WHERE organization_id = $1
              AND endpoint_id = $2
              AND conversation_id = $3
          `,
          [organizationId, link.endpoint_id, targetConversationId, previousConversationId],
        );
        await client.query(
          `
            UPDATE conversations
            SET status = 'open',
                updated_at = $3::timestamptz
            WHERE organization_id = $1
              AND id = $2
          `,
          [organizationId, previousConversationId, occurredAt],
        );
        const reverted = await client.query(
          `
            UPDATE client_identity_links
            SET reverted_at = $3::timestamptz,
                reverted_by = $4,
                reverted_by_actor_type = $5,
                reverted_reason = $6
            WHERE organization_id = $1
              AND id = $2
            RETURNING *
          `,
          [organizationId, linkId, occurredAt, actorUserId, actorType, reason],
        );

        await recalculateConversationLastMessage(
          organizationId,
          previousConversationId,
          occurredAt,
        );
        await recalculateConversationLastMessage(
          organizationId,
          targetConversationId,
          occurredAt,
        );

        return {
          reverted: true,
          reverted_link: rowToIdentityLink(reverted.rows[0]),
          previous_client_id: previousClientId,
        };
      });
    },

    async detectSequenceGaps({ organizationId, endpointId }) {
      return withTenantTransaction(organizationId, async () => {
        const sequences = await sequencesForEndpoint(organizationId, endpointId);
        const gaps = [];
        for (let index = 0; index < sequences.length - 1; index += 1) {
          const current = sequences[index];
          const next = sequences[index + 1];
          if (next > current + 1) {
            gaps.push({
              after_sequence_number: current,
              expected_sequence_number: current + 1,
              received_sequence_number: next,
            });
          }
        }

        return gaps;
      });
    },

    async selectDeliveryChannel({ organizationId, requiredCapabilities }) {
      return withTenantTransaction(organizationId, async () => {
        const result = await client.query(
          `
            SELECT
              channels.id AS channel_id,
              channels.channel_type,
              channels.status,
              jsonb_object_agg(
                adapter_capabilities.capability,
                adapter_capabilities.supported
              ) AS capabilities
            FROM channels
            JOIN adapter_capabilities
              ON adapter_capabilities.organization_id = channels.organization_id
             AND adapter_capabilities.channel_id = channels.id
            WHERE channels.organization_id = $1
              AND channels.status = 'connected'
              AND adapter_capabilities.capability = ANY($2::text[])
            GROUP BY channels.id, channels.channel_type, channels.status
            HAVING bool_and(adapter_capabilities.supported)
               AND count(DISTINCT adapter_capabilities.capability) = $3
            ORDER BY channels.created_at ASC
            LIMIT 1
          `,
          [organizationId, requiredCapabilities, requiredCapabilities.length],
        );
        if (result.rowCount === 0) {
          throw new CommunicationCoreM1NotFoundError(
            "Delivery channel with required capabilities was not found.",
          );
        }

        return result.rows[0];
      });
    },
  };

  async function findEndpointForClient({ organizationId, clientId, endpointId }) {
    const params = [organizationId, clientId];
    const endpointFilter = endpointId ? "AND id = $3" : "";
    if (endpointId) {
      params.push(endpointId);
    }

    const result = await client.query(
      `
        SELECT *
        FROM communication_endpoints
        WHERE organization_id = $1
          AND client_id = $2
          ${endpointFilter}
        ORDER BY created_at ASC
        LIMIT 1
      `,
      params,
    );

    return result.rowCount === 0 ? null : rowToEndpoint(result.rows[0]);
  }

  async function requireClient(organizationId, clientId) {
    const result = await client.query(
      `
        SELECT id
        FROM clients
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, clientId],
    );
    if (result.rowCount === 0) {
      throw new CommunicationCoreM1NotFoundError("Client was not found.");
    }
  }

  async function findConversationForEndpoint({ organizationId, endpointId, clientId }) {
    const message = await client.query(
      `
        SELECT conversation_id
        FROM messages
        WHERE organization_id = $1
          AND endpoint_id = $2
        ORDER BY created_at ASC, sequence_number ASC
        LIMIT 1
      `,
      [organizationId, endpointId],
    );
    if (message.rowCount > 0) {
      return getConversationById(organizationId, message.rows[0].conversation_id);
    }

    const conversation = await client.query(
      `
        SELECT *
        FROM conversations
        WHERE organization_id = $1
          AND client_id = $2
          AND status <> 'closed'
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [organizationId, clientId],
    );

    return conversation.rowCount === 0 ? null : rowToConversation(conversation.rows[0]);
  }

  async function recalculateConversationLastMessage(organizationId, conversationId, updatedAt) {
    await client.query(
      `
        UPDATE conversations
        SET last_message_at = (
              SELECT MAX(created_at)
              FROM messages
              WHERE organization_id = $1
                AND conversation_id = $2
            ),
            updated_at = $3::timestamptz
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, conversationId, updatedAt],
    );
  }
}

function normalizeIngressPayload(payload, clock) {
  if (!isPlainObject(payload)) {
    throw new CommunicationCoreM1ValidationError("Ingress payload must be an object.");
  }

  if (payload.contract === "C2.IngressMessage") {
    return normalizeC2IngressEnvelope(payload, clock);
  }

  return normalizeCanonicalIngress(payload, clock);
}

function normalizeC2IngressEnvelope(payload, clock) {
  const errors = [];
  expectEqual(errors, payload.version, C2_VERSION, "version");
  expectNonBlank(errors, payload.idempotency_key, "idempotency_key");
  expectRecord(errors, payload.message, "message");

  const message = payload.message ?? {};
  expectNonBlank(errors, message.message_id, "message.message_id");
  expectNonBlank(errors, message.organization_id, "message.organization_id");
  expectNonBlank(errors, message.channel_id, "message.channel_id");
  expectNonBlank(errors, message.channel_type, "message.channel_type");
  expectEqual(errors, message.direction, MESSAGE_DIRECTION.INBOUND, "message.direction");
  expectRecord(errors, message.content, "message.content");

  if (
    typeof payload.idempotency_key === "string" &&
    typeof message.message_id === "string" &&
    payload.idempotency_key !== message.message_id
  ) {
    errors.push("idempotency_key must match message.message_id");
  }
  if (typeof payload.idempotency_key === "string" && !isUuid(payload.idempotency_key)) {
    errors.push("idempotency_key must be a UUID string");
  }
  if (typeof message.message_id === "string" && !isUuid(message.message_id)) {
    errors.push("message.message_id must be a UUID string");
  }
  if (
    message.sequence_number !== undefined &&
    (!Number.isSafeInteger(message.sequence_number) || message.sequence_number < 1)
  ) {
    errors.push("message.sequence_number must be a positive integer");
  }

  if (errors.length > 0) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid C2 ingress: ${errors.join("; ")}`,
      errors,
    );
  }

  const organizationId = assertUuidOrDerive(message.organization_id, "message.organization_id");
  const idempotencyKey = String(payload.idempotency_key);
  const messageId = toMessageUuid(message.message_id, idempotencyKey);
  const occurredAt = normalizeTimestamp(message.occurred_at ?? payload.received_at ?? clock());
  const channel = normalizeChannel(message.channel_type);
  const type = normalizeMessageType(message.content.type);
  const endpointExternalId = `${message.channel_id}:${message.sender_ref ?? message.conversation_ref ?? "anonymous"}`;
  const identity = normalizeIdentityEvidence(message.identity ?? message.verified_identity);

  return {
    idempotencyKey,
    organizationId,
    channel,
    channelId: String(message.channel_id),
    endpointExternalId,
    conversationRef: message.conversation_ref ?? null,
    identity,
    senderRef: message.sender_ref ?? null,
    occurredAt,
    routedAt: clock(),
    message: {
      id: messageId,
      organization_id: organizationId,
      conversation_id: null,
      endpoint_id: null,
      channel,
      direction: MESSAGE_DIRECTION.INBOUND,
      sender_type: MESSAGE_SENDER_TYPE.CLIENT,
      sequence_number: message.sequence_number ?? null,
      type,
      content: normalizeContent(message.content, type),
      status: MESSAGE_STATUS.RECEIVED,
      created_at: occurredAt,
    },
    attachments: normalizeAttachments(message.attachments ?? [], {
      organizationId,
      messageId,
      occurredAt,
      preserveIds: false,
    }),
  };
}

function normalizeCanonicalIngress(payload, clock) {
  const validation = validateCanonicalMessage(payload);
  if (!validation.valid) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid C1 ingress: ${validation.errors.join("; ")}`,
      validation.errors,
    );
  }

  if (payload.direction !== MESSAGE_DIRECTION.INBOUND) {
    throw new CommunicationCoreM1ValidationError("direction must be inbound for ingress.");
  }
  if (payload.status !== MESSAGE_STATUS.RECEIVED) {
    throw new CommunicationCoreM1ValidationError("status must be received for ingress.");
  }

  const occurredAt = normalizeTimestamp(payload.created_at);
  const channel = normalizeChannel(payload.channel);
  const endpointExternalId = payload.metadata?.external_id ?? payload.endpoint_id;
  const identity = normalizeIdentityEvidence(payload.identity ?? payload.metadata?.identity);

  return {
    idempotencyKey: payload.idempotency_key,
    organizationId: payload.organization_id,
    channel,
    channelId: payload.metadata?.channel_id ?? endpointExternalId,
    endpointExternalId,
    conversationRef: payload.metadata?.conversation_ref ?? payload.conversation_id,
    identity,
    senderRef: payload.metadata?.sender_ref ?? null,
    clientId: payload.client_id ?? null,
    endpointId: payload.endpoint_id,
    conversationId: payload.conversation_id,
    occurredAt,
    routedAt: clock(),
    message: {
      id: payload.id,
      organization_id: payload.organization_id,
      conversation_id: payload.conversation_id,
      endpoint_id: payload.endpoint_id,
      channel,
      direction: MESSAGE_DIRECTION.INBOUND,
      sender_type: MESSAGE_SENDER_TYPE.CLIENT,
      sequence_number: payload.sequence_number,
      type: payload.type,
      content: payload.content,
      status: MESSAGE_STATUS.RECEIVED,
      created_at: occurredAt,
    },
    attachments: normalizeAttachments(payload.attachments ?? [], {
      organizationId: payload.organization_id,
      messageId: payload.id,
      occurredAt,
      preserveIds: true,
    }),
  };
}

function normalizeOutboundPayload(payload, clock) {
  if (!isPlainObject(payload)) {
    throw new CommunicationCoreM1ValidationError("Outbound payload must be an object.");
  }

  const errors = [];
  expectNonBlank(errors, payload.idempotency_key, "idempotency_key");
  expectNonBlank(errors, payload.organization_id, "organization_id");
  expectNonBlank(errors, payload.conversation_id, "conversation_id");
  expectRecord(errors, payload.content, "content");

  if (errors.length > 0) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid outbound message: ${errors.join("; ")}`,
      errors,
    );
  }

  const organizationId = assertUuidOrDerive(payload.organization_id, "organization_id");
  const messageId = toMessageUuid(payload.idempotency_key, payload.idempotency_key);
  const type = normalizeMessageType(payload.type ?? payload.content.type ?? "text");
  const createdAt = normalizeTimestamp(payload.created_at ?? clock());
  const senderType = payload.sender_type ?? MESSAGE_SENDER_TYPE.MANAGER;

  if (senderType !== MESSAGE_SENDER_TYPE.MANAGER) {
    throw new CommunicationCoreM1ValidationError(
      "sender_type must be manager for POST /messages in M1.",
    );
  }

  return {
    organizationId,
    conversationId: assertUuidOrDerive(payload.conversation_id, "conversation_id"),
    endpointId: payload.endpoint_id ? assertUuidOrDerive(payload.endpoint_id, "endpoint_id") : null,
    message: {
      id: messageId,
      organization_id: organizationId,
      conversation_id: payload.conversation_id,
      endpoint_id: payload.endpoint_id ?? null,
      channel: payload.channel ?? "web_chat",
      direction: MESSAGE_DIRECTION.OUTBOUND,
      sender_type: senderType,
      sequence_number: null,
      type,
      content: normalizeContent(payload.content, type),
      status: MESSAGE_STATUS.ROUTED,
      created_at: createdAt,
    },
  };
}

function normalizeLegacyEgressPayload(message, target) {
  const validation = validateCanonicalMessage(message);
  if (!validation.valid) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid C1 egress: ${validation.errors.join("; ")}`,
      validation.errors,
    );
  }
  if (message.direction !== MESSAGE_DIRECTION.OUTBOUND) {
    throw new CommunicationCoreM1ValidationError("direction must be outbound for egress.");
  }
  if (message.status !== MESSAGE_STATUS.ROUTED) {
    throw new CommunicationCoreM1ValidationError("status must be routed for egress.");
  }
  if (!isPlainObject(target)) {
    throw new CommunicationCoreM1ValidationError("delivery target must be an object.");
  }
  expectRequiredTarget(target);

  return {
    ...message,
    channel: normalizeChannel(message.channel),
  };
}

function normalizeOutboxPublisher(publisher) {
  if (typeof publisher === "function") {
    return publisher;
  }
  if (publisher && typeof publisher.publish === "function") {
    return (event) => publisher.publish(event);
  }

  throw new CommunicationCoreM1ValidationError(
    "outbox publisher must be a function or expose publish(event).",
  );
}

function assertInboundCanBeRouted(message) {
  if (!assertStatusTransition(message.status, MESSAGE_STATUS.ROUTED)) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid status transition: ${message.status} -> ${MESSAGE_STATUS.ROUTED}`,
    );
  }
}

function transitionStoredMessage(message, status, changedAt) {
  if (!assertStatusTransition(message.status, status)) {
    throw new CommunicationCoreM1ValidationError(
      `Invalid status transition: ${message.status} -> ${status}`,
    );
  }

  const timestampField =
    status === MESSAGE_STATUS.ROUTED
      ? "routed_at"
      : status === MESSAGE_STATUS.SENT
        ? "sent_at"
        : status === MESSAGE_STATUS.FAILED
          ? "failed_at"
          : null;

  return {
    ...message,
    status,
    ...(timestampField ? { [timestampField]: changedAt } : {}),
  };
}

export function buildC2EgressDelivery({ message, endpoint }) {
  const channelId = endpoint.metadata?.channel_id ?? endpoint.external_id ?? endpoint.id;
  const conversationRef =
    endpoint.metadata?.conversation_ref ??
    message.metadata?.conversation_ref ??
    message.conversation_ref ??
    message.conversation_id;
  const channelType = endpoint.channel ?? message.channel;
  const content = {
    ...message.content,
    type: message.type,
  };

  return {
    contract: "C2.EgressDelivery",
    version: C2_VERSION,
    idempotency_key: message.id,
    channel_id: channelId,
    message: {
      message_id: message.id,
      organization_id: message.organization_id,
      channel_id: channelId,
      channel_type: channelType,
      conversation_ref: conversationRef,
      direction: MESSAGE_DIRECTION.OUTBOUND,
      content,
    },
  };
}

function normalizeAttachments(
  attachments,
  { organizationId, messageId, occurredAt, preserveIds = true },
) {
  if (!Array.isArray(attachments)) {
    throw new CommunicationCoreM1ValidationError("attachments must be an array.");
  }

  return attachments.map((attachment, index) => {
    if (!isPlainObject(attachment)) {
      throw new CommunicationCoreM1ValidationError(`attachments[${index}] must be an object.`);
    }

    const kind = attachment.kind ?? attachment.type;
    const storageRef = attachment.storage_ref ?? attachment.url ?? attachment.id;
    const size = attachment.size ?? 0;

    if (typeof kind !== "string" || kind.trim() === "") {
      throw new CommunicationCoreM1ValidationError(`attachments[${index}].kind is required.`);
    }
    if (typeof storageRef !== "string" || storageRef.trim() === "") {
      throw new CommunicationCoreM1ValidationError(
        `attachments[${index}].storage_ref is required.`,
      );
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new CommunicationCoreM1ValidationError(
        `attachments[${index}].size must be a non-negative integer.`,
      );
    }

    return {
      id: preserveIds && attachment.id && isUuid(attachment.id)
        ? attachment.id
        : uuidFromText(`${organizationId}:attachment:${messageId}:${index}`),
      organization_id: organizationId,
      message_id: messageId,
      kind,
      storage_ref: storageRef,
      mime: attachment.mime ?? null,
      size,
      metadata: attachment.metadata ?? {},
      created_at: occurredAt,
    };
  });
}

function normalizeContent(content, type) {
  if (!isPlainObject(content)) {
    throw new CommunicationCoreM1ValidationError("content must be an object.");
  }

  return {
    ...content,
    type,
  };
}

function normalizeIdentityEvidence(identity) {
  if (identity === undefined || identity === null) {
    return null;
  }
  if (!isPlainObject(identity)) {
    throw new CommunicationCoreM1ValidationError("identity must be an object.");
  }

  const linkType = identity.link_type ?? identity.type;
  const value = identity.value ?? identity.identifier;
  if (!AUTO_IDENTITY_LINK_TYPES.has(linkType)) {
    throw new CommunicationCoreM1ValidationError(
      "identity.link_type must be verified_phone, verified_email, or link_code.",
    );
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommunicationCoreM1ValidationError("identity.value must be a non-empty string.");
  }

  const normalizedValue = value.trim().toLowerCase();
  const verified = identity.verified === true;

  return {
    link_type: linkType,
    value: normalizedValue,
    verified,
    evidence: {
      identity_value: normalizedValue,
      identity_verified: verified,
      ...(identity.verified_at ? { verified_at: normalizeTimestamp(identity.verified_at) } : {}),
      ...(identity.source ? { source: identity.source } : {}),
    },
  };
}

function isVerifiedIdentity(identity) {
  return (
    identity !== null &&
    identity !== undefined &&
    identity.verified === true &&
    AUTO_IDENTITY_LINK_TYPES.has(identity.link_type)
  );
}

function normalizeMessageType(type) {
  const normalized = type === "voice" ? "audio" : type;

  if (!VALID_MESSAGE_TYPES.has(normalized)) {
    throw new CommunicationCoreM1ValidationError(`Unsupported message type: ${type}`);
  }

  return normalized;
}

function normalizeChannel(channel) {
  const normalized = channel === "mock" ? "web_chat" : channel;

  if (!VALID_CHANNELS.has(normalized)) {
    throw new CommunicationCoreM1ValidationError(`Unsupported channel: ${channel}`);
  }

  return normalized;
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CommunicationCoreM1ValidationError("Timestamp must be a valid date-time.");
  }

  return date.toISOString();
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? 50), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 50;
  }

  return Math.min(parsed, 100);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertUuid(value, field) {
  if (!isUuid(value)) {
    throw new CommunicationCoreM1ValidationError(`${field} must be a UUID string.`);
  }
}

function assertUuidOrDerive(value, field) {
  if (isUuid(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommunicationCoreM1ValidationError(`${field} is required.`);
  }

  return uuidFromText(`${field}:${value}`);
}

function toMessageUuid(value, fallback) {
  if (isUuid(value)) {
    return value;
  }

  return uuidFromText(`message:${value ?? fallback}`);
}

export function uuidFromText(value) {
  const hex = createHash("md5").update(String(value)).digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function expectRecord(errors, value, path) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
  }
}

function expectNonBlank(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}

function expectEqual(errors, actual, expected, path) {
  if (actual !== expected) {
    errors.push(`${path} must equal ${JSON.stringify(expected)}`);
  }
}

function expectRequiredTarget(target) {
  const errors = [];
  expectNonBlank(errors, target.adapter, "adapter");
  expectNonBlank(errors, target.adapter_endpoint_id, "adapter_endpoint_id");

  if (errors.length > 0) {
    throw new CommunicationCoreM1ValidationError(errors.join("; "), errors);
  }
}

function messageKey(organizationId, messageId) {
  return `${organizationId}:${messageId}`;
}

function clientKey(organizationId, clientId) {
  return `${organizationId}:${clientId}`;
}

function endpointKey(organizationId, endpointId) {
  return `${organizationId}:${endpointId}`;
}

function conversationKey(organizationId, conversationId) {
  return `${organizationId}:${conversationId}`;
}

function identityLinkKey(organizationId, linkId) {
  return `${organizationId}:${linkId}`;
}

function outboxEventKey(organizationId, eventId) {
  return `${organizationId}:${eventId}`;
}

function channelKey(organizationId, channelId) {
  return `${organizationId}:${channelId}`;
}

function broadcastKey(organizationId, broadcastId) {
  return `${organizationId}:${broadcastId}`;
}

function broadcastMessageKey(organizationId, broadcastId, messageId) {
  return `${organizationId}:${broadcastId}:${messageId}`;
}

function compareConversations(left, right) {
  const leftTime = left.last_message_at ?? left.created_at;
  const rightTime = right.last_message_at ?? right.created_at;

  return rightTime.localeCompare(leftTime);
}

function compareMessages(left, right) {
  return (
    left.sequence_number - right.sequence_number ||
    left.created_at.localeCompare(right.created_at)
  );
}

function compareOutboxEvents(left, right) {
  return (
    left.created_at.localeCompare(right.created_at) ||
    (OUTBOX_EVENT_ORDER.get(left.event_type) ?? 100) -
      (OUTBOX_EVENT_ORDER.get(right.event_type) ?? 100) ||
    left.id.localeCompare(right.id)
  );
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function rowToConversation(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    client_id: row.client_id,
    status: row.status,
    last_message_at: row.last_message_at?.toISOString?.() ?? row.last_message_at,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
    updated_at: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

function rowToEndpoint(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    client_id: row.client_id,
    channel: row.channel,
    external_id: row.external_id,
    verified: row.verified,
    verified_at: row.verified_at?.toISOString?.() ?? row.verified_at,
    metadata: row.metadata ?? {},
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

function rowToMessage(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    conversation_id: row.conversation_id,
    endpoint_id: row.endpoint_id,
    channel: row.channel,
    direction: row.direction,
    sender_type: row.sender_type,
    sequence_number: Number(row.sequence_number),
    type: row.type,
    content: row.content ?? {},
    status: row.status,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
    delivered_at: row.delivered_at?.toISOString?.() ?? row.delivered_at,
  };
}

function rowToAttachment(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    message_id: row.message_id,
    kind: row.kind,
    storage_ref: row.storage_ref,
    mime: row.mime,
    size: Number(row.size),
    metadata: row.metadata ?? {},
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

function rowToDeliveryAttempt(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    message_id: row.message_id,
    adapter: row.adapter,
    attempt_no: row.attempt_no,
    status: row.status,
    error: row.error,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

function rowToBroadcastMessage(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    broadcast_id: row.broadcast_id,
    message_id: row.message_id,
    status: row.status,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
    updated_at: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

function rowToIdentityLink(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    client_id: row.client_id,
    endpoint_id: row.endpoint_id,
    link_type: row.link_type,
    evidence: row.evidence ?? {},
    created_by: row.created_by ?? null,
    created_by_actor_type: row.created_by_actor_type,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
    reverted_at: row.reverted_at?.toISOString?.() ?? row.reverted_at,
    reverted_by: row.reverted_by ?? null,
    reverted_by_actor_type: row.reverted_by_actor_type ?? null,
    reverted_reason: row.reverted_reason ?? null,
  };
}

function rowToOutboxEvent(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    event_type: row.event_type,
    payload: row.payload ?? {},
    status: row.status,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
    published_at: row.published_at?.toISOString?.() ?? row.published_at,
  };
}
