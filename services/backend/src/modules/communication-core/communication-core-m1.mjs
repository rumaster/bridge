import { createHash, randomUUID } from "node:crypto";

import {
  MESSAGE_DIRECTION,
  MESSAGE_SENDER_TYPE,
  MESSAGE_STATUS,
  assertMessageStatusTransition,
  validateCanonicalMessage,
} from "../../../../../packages/contracts/message-model/index.mjs";

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

export function createCommunicationCoreM1Service({
  store = new InMemoryCommunicationCoreStore(),
  clock = () => new Date().toISOString(),
  egressAdapter = createMockC2EgressAdapter({ clock }),
} = {}) {
  return {
    async acceptIngressMessage(payload) {
      const ingress = normalizeIngressPayload(payload, clock);
      assertInboundCanBeRouted(ingress.message);

      const result = await store.recordInboundMessage(ingress);

      return {
        accepted: true,
        duplicate: result.duplicate,
        message_id: result.message.id,
        idempotency_key: ingress.idempotencyKey,
        organization_id: result.message.organization_id,
        conversation_id: result.conversation.id,
        endpoint_id: result.endpoint.id,
        sequence_number: result.message.sequence_number,
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

      return outboundResponse({
        duplicate: false,
        message: delivered.message,
        conversation: delivered.conversation,
        endpoint: prepared.endpoint,
        deliveryAttempt: delivered.deliveryAttempt,
      });
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

export class InMemoryCommunicationCoreStore {
  constructor() {
    this.clients = new Map();
    this.endpoints = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.attachments = new Map();
    this.deliveryAttempts = new Map();
  }

  async recordInboundMessage(ingress) {
    const existing = this.messages.get(messageKey(ingress.organizationId, ingress.message.id));
    if (existing) {
      return this.resultForExistingMessage(ingress.organizationId, existing);
    }

    const endpoint = this.resolveEndpoint(ingress);
    const conversation = this.resolveConversation({
      organizationId: ingress.organizationId,
      clientId: endpoint.client_id,
      conversationId: ingress.conversationId,
      conversationRef: ingress.conversationRef,
      occurredAt: ingress.occurredAt,
    });
    const sequenceNumber =
      ingress.message.sequence_number ?? this.nextSequenceNumber(ingress.organizationId, endpoint.id);
    const received = {
      ...ingress.message,
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

    return {
      duplicate: false,
      message: clone(routed),
      conversation: clone(conversation),
      endpoint: clone(endpoint),
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
      conversation_id: conversation.id,
      endpoint_id: endpoint.id,
      channel: endpoint.channel,
      sequence_number: this.nextSequenceNumber(outbound.organizationId, endpoint.id),
      status: MESSAGE_STATUS.ROUTED,
    };

    this.messages.set(messageKey(outbound.organizationId, message.id), message);
    this.attachments.set(messageKey(outbound.organizationId, message.id), []);
    this.updateConversationLastMessage(conversation, message.created_at, message.created_at);

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
      return existing;
    }

    const clientId =
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
        sender_ref: ingress.senderRef,
      },
      created_at: ingress.occurredAt,
    };

    this.clients.set(clientKey(ingress.organizationId, clientId), client);
    this.endpoints.set(endpointKey(ingress.organizationId, endpointId), endpoint);

    return endpoint;
  }

  resolveConversation({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    if (conversationId) {
      const existing = this.conversations.get(conversationKey(organizationId, conversationId));
      if (existing) {
        return existing;
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
      return openConversation;
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

    return conversation;
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
      return rowToEndpoint(existing.rows[0]);
    }

    const clientId =
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

    return rowToEndpoint(created.rows[0]);
  }

  async function resolveConversation({
    organizationId,
    clientId,
    conversationId,
    conversationRef,
    occurredAt,
  }) {
    if (conversationId) {
      const existing = await getConversationById(organizationId, conversationId);
      if (existing) {
        return existing;
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
      return rowToConversation(open.rows[0]);
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

    return rowToConversation(created.rows[0]);
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

  return {
    async recordInboundMessage(ingress) {
      return withTenantTransaction(ingress.organizationId, async () => {
        const existing = await getMessageWithContext(ingress.organizationId, ingress.message.id);
        if (existing) {
          return resultForExistingMessage(ingress.organizationId, existing);
        }

        const endpoint = await resolveEndpoint(ingress);
        const conversation = await resolveConversation({
          organizationId: ingress.organizationId,
          clientId: endpoint.client_id,
          conversationId: ingress.conversationId,
          conversationRef: ingress.conversationRef,
          occurredAt: ingress.occurredAt,
        });
        const sequenceNumber =
          ingress.message.sequence_number ??
          (await nextSequenceNumber(ingress.organizationId, endpoint.id));
        const routedAt = ingress.routedAt;

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
        const updatedConversation = await getConversationById(
          ingress.organizationId,
          conversation.id,
        );

        return {
          duplicate: false,
          message,
          conversation: updatedConversation,
          endpoint,
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
        const conversation = await getConversationById(organizationId, message.conversation_id);

        return {
          message,
          conversation,
          deliveryAttempt: rowToDeliveryAttempt(attempt.rows[0]),
        };
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

  return {
    idempotencyKey,
    organizationId,
    channel,
    channelId: String(message.channel_id),
    endpointExternalId,
    conversationRef: message.conversation_ref ?? null,
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
      sequence_number: null,
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

  return {
    idempotencyKey: payload.idempotency_key,
    organizationId: payload.organization_id,
    channel,
    channelId: payload.metadata?.channel_id ?? endpointExternalId,
    endpointExternalId,
    conversationRef: payload.metadata?.conversation_ref ?? payload.conversation_id,
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

function buildC2EgressDelivery({ message, endpoint }) {
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

function uuidFromText(value) {
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
