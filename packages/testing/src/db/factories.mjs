import { randomUUID } from "node:crypto";

import {
  assertNonBlankText,
  assertPositiveInteger,
  assertUtcTimestamptz,
  assertUuid,
  toUtcTimestamptz,
} from "./primitives.mjs";

export const TEST_EMBEDDING_DIMENSIONS = 1536;

export function createDeterministicEmbedding(
  seed = "bridge-test-embedding",
  dimensions = TEST_EMBEDDING_DIMENSIONS,
) {
  assertNonBlankText(seed, "embedding.seed");
  assertPositiveInteger(dimensions, "embedding.dimensions");

  let state = 0;
  for (const char of seed) {
    state = (Math.imul(state, 31) + char.charCodeAt(0)) >>> 0;
  }

  return Array.from({ length: dimensions }, (_, index) => {
    state = (Math.imul(state + index + 1, 1664525) + 1013904223) >>> 0;
    return Number(((state / 0xffffffff) * 2 - 1).toFixed(6));
  });
}

export function assertEmbeddingVector(
  value,
  fieldName = "embedding",
  dimensions = TEST_EMBEDDING_DIMENSIONS,
) {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new TypeError(`${fieldName} must be a ${dimensions}-dimension embedding vector`);
  }

  for (const [index, coordinate] of value.entries()) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new TypeError(`${fieldName}[${index}] must be a finite number`);
    }
  }

  return value;
}

export function formatPgVector(value, fieldName = "embedding") {
  return `[${assertEmbeddingVector(value, fieldName).join(",")}]`;
}

export function createTestOrganization(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const organization = {
    id: randomUUID(),
    name: "Test Organization",
    description: null,
    timezone: "UTC",
    locale: "ru-RU",
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(organization.id, "organization.id");
  assertUtcTimestamptz(organization.created_at, "organization.created_at");
  assertUtcTimestamptz(organization.updated_at, "organization.updated_at");

  return organization;
}

export function createTestUser(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const user = {
    id: randomUUID(),
    organization_id: randomUUID(),
    telegram_username: null,
    email: "user@example.bridge.local",
    display_name: "Test User",
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(user.id, "user.id");
  if (user.organization_id !== null) {
    assertUuid(user.organization_id, "user.organization_id");
  }
  assertUtcTimestamptz(user.created_at, "user.created_at");
  assertUtcTimestamptz(user.updated_at, "user.updated_at");

  return user;
}

export function createTestClient(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const client = {
    id: randomUUID(),
    organization_id: randomUUID(),
    display_name: "Test Client",
    anonymized_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(client.id, "client.id");
  assertUuid(client.organization_id, "client.organization_id");
  if (client.display_name !== null) {
    assertNonBlankText(client.display_name, "client.display_name");
  }
  if (client.anonymized_at !== null) {
    assertUtcTimestamptz(client.anonymized_at, "client.anonymized_at");
  }
  assertUtcTimestamptz(client.created_at, "client.created_at");
  assertUtcTimestamptz(client.updated_at, "client.updated_at");

  return client;
}

export function createTestConversation(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const conversation = {
    id: randomUUID(),
    organization_id: randomUUID(),
    client_id: randomUUID(),
    status: "open",
    last_message_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(conversation.id, "conversation.id");
  assertUuid(conversation.organization_id, "conversation.organization_id");
  assertUuid(conversation.client_id, "conversation.client_id");
  if (!["open", "closed", "pending"].includes(conversation.status)) {
    throw new TypeError("conversation.status must be open, closed, or pending");
  }
  if (conversation.last_message_at !== null) {
    assertUtcTimestamptz(conversation.last_message_at, "conversation.last_message_at");
  }
  assertUtcTimestamptz(conversation.created_at, "conversation.created_at");
  assertUtcTimestamptz(conversation.updated_at, "conversation.updated_at");

  return conversation;
}

export function createTestMessage(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const message = {
    id: randomUUID(),
    organization_id: randomUUID(),
    conversation_id: randomUUID(),
    endpoint_id: randomUUID(),
    channel: "web_chat",
    direction: "inbound",
    sender_type: "client",
    sequence_number: 1,
    type: "text",
    content: { text: "Hello" },
    status: "received",
    created_at: createdAt,
    delivered_at: null,
    ...overrides,
  };

  assertUuid(message.id, "message.id");
  assertUuid(message.organization_id, "message.organization_id");
  assertUuid(message.conversation_id, "message.conversation_id");
  assertUuid(message.endpoint_id, "message.endpoint_id");
  assertNonBlankText(message.channel, "message.channel");
  if (!["inbound", "outbound"].includes(message.direction)) {
    throw new TypeError("message.direction must be inbound or outbound");
  }
  if (!["client", "manager", "ai", "broadcast", "system"].includes(message.sender_type)) {
    throw new TypeError("message.sender_type must be client, manager, ai, broadcast, or system");
  }
  assertPositiveInteger(message.sequence_number, "message.sequence_number");
  assertNonBlankText(message.type, "message.type");
  if (message.content === null || typeof message.content !== "object" || Array.isArray(message.content)) {
    throw new TypeError("message.content must be a JSON object");
  }
  if (!["received", "routed", "sent", "delivered", "failed"].includes(message.status)) {
    throw new TypeError("message.status must be received, routed, sent, delivered, or failed");
  }
  assertUtcTimestamptz(message.created_at, "message.created_at");
  if (message.delivered_at !== null) {
    assertUtcTimestamptz(message.delivered_at, "message.delivered_at");
  }

  return message;
}

export function createTestKnowledgeDocument(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const document = {
    id: randomUUID(),
    organization_id: randomUUID(),
    title: "FAQ: delivery policy",
    source: "manual://kb/delivery",
    status: "indexing",
    indexed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(document.id, "knowledge_document.id");
  assertUuid(document.organization_id, "knowledge_document.organization_id");
  assertNonBlankText(document.title, "knowledge_document.title");
  if (document.source !== null) {
    assertNonBlankText(document.source, "knowledge_document.source");
  }
  if (!["indexing", "indexed", "failed"].includes(document.status)) {
    throw new TypeError("knowledge_document.status must be indexing, indexed, or failed");
  }
  if (document.indexed_at !== null) {
    assertUtcTimestamptz(document.indexed_at, "knowledge_document.indexed_at");
  }
  assertUtcTimestamptz(document.created_at, "knowledge_document.created_at");
  assertUtcTimestamptz(document.updated_at, "knowledge_document.updated_at");

  return document;
}

export function createTestKnowledgeChunk(overrides = {}) {
  const chunkNo = overrides.chunk_no ?? 1;
  const chunk = {
    id: randomUUID(),
    organization_id: randomUUID(),
    document_id: randomUUID(),
    chunk_no: chunkNo,
    content: "Delivery takes one business day inside the city.",
    embedding: createDeterministicEmbedding(`knowledge-chunk:${chunkNo}`),
    metadata: {},
    created_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(chunk.id, "knowledge_chunk.id");
  assertUuid(chunk.organization_id, "knowledge_chunk.organization_id");
  assertUuid(chunk.document_id, "knowledge_chunk.document_id");
  assertPositiveInteger(chunk.chunk_no, "knowledge_chunk.chunk_no");
  assertNonBlankText(chunk.content, "knowledge_chunk.content");
  assertEmbeddingVector(chunk.embedding, "knowledge_chunk.embedding");
  if (chunk.metadata === null || typeof chunk.metadata !== "object" || Array.isArray(chunk.metadata)) {
    throw new TypeError("knowledge_chunk.metadata must be a JSON object");
  }
  assertUtcTimestamptz(chunk.created_at, "knowledge_chunk.created_at");

  return chunk;
}

const WORKFLOW_STATUSES = ["draft", "active", "archived"];
const WORKFLOW_INSTANCE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];
const OUTBOX_EVENT_STATUSES = ["pending", "published", "failed"];
const BROADCAST_STATUSES = ["draft", "scheduled", "running", "done", "failed"];
const BROADCAST_DELIVERY_STATUSES = [
  "prepared",
  "sent",
  "delivered",
  "failed",
  "skipped",
];
const NOTIFICATION_CATEGORIES = ["info", "warning", "error", "critical", "admin"];
const NOTIFICATION_CHANNELS = ["web", "telegram", "email", "push"];
const NOTIFICATION_STATUSES = ["new", "read"];

function assertJsonObject(value, fieldName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be a JSON object`);
  }

  return value;
}

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }

  return value;
}

export function createTestWorkflow(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const workflow = {
    id: randomUUID(),
    organization_id: randomUUID(),
    name: "Automation Workflow",
    status: "draft",
    default_version_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(workflow.id, "workflow.id");
  assertUuid(workflow.organization_id, "workflow.organization_id");
  assertNonBlankText(workflow.name, "workflow.name");
  if (!WORKFLOW_STATUSES.includes(workflow.status)) {
    throw new TypeError(`workflow.status must be one of ${WORKFLOW_STATUSES.join(", ")}`);
  }
  if (workflow.default_version_id !== null) {
    assertUuid(workflow.default_version_id, "workflow.default_version_id");
  }
  assertUtcTimestamptz(workflow.created_at, "workflow.created_at");
  assertUtcTimestamptz(workflow.updated_at, "workflow.updated_at");

  return workflow;
}

export function createTestWorkflowVersion(overrides = {}) {
  const versionNo = overrides.version_no ?? 1;
  const version = {
    id: randomUUID(),
    organization_id: randomUUID(),
    workflow_id: randomUUID(),
    version_no: versionNo,
    schema: { nodes: [], edges: [] },
    created_by: null,
    created_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(version.id, "workflow_version.id");
  assertUuid(version.organization_id, "workflow_version.organization_id");
  assertUuid(version.workflow_id, "workflow_version.workflow_id");
  assertPositiveInteger(version.version_no, "workflow_version.version_no");
  assertJsonObject(version.schema, "workflow_version.schema");
  if (version.created_by !== null) {
    assertUuid(version.created_by, "workflow_version.created_by");
  }
  assertUtcTimestamptz(version.created_at, "workflow_version.created_at");

  return version;
}

// Валидатор монотонности version_no (ТЗ §13.10): версии в рамках одного workflow
// нумеруются строго возрастающими положительными целыми.
export function assertMonotonicWorkflowVersionNumbers(
  versions,
  fieldName = "workflow_versions",
) {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty array of versions`);
  }

  let previous = null;
  for (const [index, version] of versions.entries()) {
    const versionNo =
      typeof version === "number" ? version : version?.version_no;
    assertPositiveInteger(versionNo, `${fieldName}[${index}].version_no`);

    if (previous !== null && versionNo <= previous) {
      throw new TypeError(
        `${fieldName}[${index}].version_no must be strictly greater than the previous version_no`,
      );
    }

    previous = versionNo;
  }

  return versions;
}

export function isMonotonicWorkflowVersionNumbers(versions) {
  try {
    assertMonotonicWorkflowVersionNumbers(versions);
    return true;
  } catch {
    return false;
  }
}

export function createTestWorkflowVersionSequence(count = 2, overrides = {}) {
  assertPositiveInteger(count, "workflow_version_sequence.count");
  const workflowId = overrides.workflow_id ?? randomUUID();
  const organizationId = overrides.organization_id ?? randomUUID();

  return Array.from({ length: count }, (_, index) =>
    createTestWorkflowVersion({
      workflow_id: workflowId,
      organization_id: organizationId,
      version_no: index + 1,
      ...overrides,
    }),
  );
}

export function createTestWorkflowInstance(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const instance = {
    id: randomUUID(),
    organization_id: randomUUID(),
    workflow_id: randomUUID(),
    version_id: randomUUID(),
    status: "pending",
    started_at: null,
    finished_at: null,
    created_at: createdAt,
    ...overrides,
  };

  assertUuid(instance.id, "workflow_instance.id");
  assertUuid(instance.organization_id, "workflow_instance.organization_id");
  assertUuid(instance.workflow_id, "workflow_instance.workflow_id");
  assertUuid(instance.version_id, "workflow_instance.version_id");
  if (!WORKFLOW_INSTANCE_STATUSES.includes(instance.status)) {
    throw new TypeError(
      `workflow_instance.status must be one of ${WORKFLOW_INSTANCE_STATUSES.join(", ")}`,
    );
  }
  assertUtcTimestamptz(instance.created_at, "workflow_instance.created_at");
  if (instance.started_at !== null) {
    assertUtcTimestamptz(instance.started_at, "workflow_instance.started_at");
  }
  if (instance.finished_at !== null) {
    assertUtcTimestamptz(instance.finished_at, "workflow_instance.finished_at");
    if (instance.started_at === null) {
      throw new TypeError(
        "workflow_instance.finished_at requires workflow_instance.started_at",
      );
    }
    if (instance.finished_at < instance.started_at) {
      throw new TypeError(
        "workflow_instance.finished_at must be greater than or equal to started_at",
      );
    }
  }

  return instance;
}

export function createTestWorkflowInstanceState(overrides = {}) {
  const state = {
    instance_id: randomUUID(),
    organization_id: randomUUID(),
    state: { cursor: 0 },
    updated_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(state.instance_id, "workflow_instance_state.instance_id");
  assertUuid(state.organization_id, "workflow_instance_state.organization_id");
  assertJsonObject(state.state, "workflow_instance_state.state");
  assertUtcTimestamptz(state.updated_at, "workflow_instance_state.updated_at");

  return state;
}

export function createTestWorkflowExecutionLog(overrides = {}) {
  const log = {
    id: randomUUID(),
    organization_id: randomUUID(),
    instance_id: randomUUID(),
    node_id: "node-1",
    event: "node.started",
    data: {},
    created_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(log.id, "workflow_execution_log.id");
  assertUuid(log.organization_id, "workflow_execution_log.organization_id");
  assertUuid(log.instance_id, "workflow_execution_log.instance_id");
  if (log.node_id !== null) {
    assertNonBlankText(log.node_id, "workflow_execution_log.node_id");
  }
  assertNonBlankText(log.event, "workflow_execution_log.event");
  assertJsonObject(log.data, "workflow_execution_log.data");
  assertUtcTimestamptz(log.created_at, "workflow_execution_log.created_at");

  return log;
}

export function createTestOutboxEvent(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const event = {
    id: randomUUID(),
    organization_id: randomUUID(),
    aggregate_type: "message",
    aggregate_id: randomUUID(),
    event_type: "message.received",
    payload: {},
    status: "pending",
    created_at: createdAt,
    published_at: null,
    ...overrides,
  };

  assertUuid(event.id, "outbox_event.id");
  assertUuid(event.organization_id, "outbox_event.organization_id");
  assertNonBlankText(event.aggregate_type, "outbox_event.aggregate_type");
  assertUuid(event.aggregate_id, "outbox_event.aggregate_id");
  assertNonBlankText(event.event_type, "outbox_event.event_type");
  assertJsonObject(event.payload, "outbox_event.payload");
  if (!OUTBOX_EVENT_STATUSES.includes(event.status)) {
    throw new TypeError(
      `outbox_event.status must be one of ${OUTBOX_EVENT_STATUSES.join(", ")}`,
    );
  }
  assertUtcTimestamptz(event.created_at, "outbox_event.created_at");
  if (event.status === "published") {
    if (event.published_at === null) {
      throw new TypeError("outbox_event.published_at is required when status is published");
    }
  } else if (event.published_at !== null) {
    throw new TypeError(
      "outbox_event.published_at must be null unless status is published",
    );
  }
  if (event.published_at !== null) {
    assertUtcTimestamptz(event.published_at, "outbox_event.published_at");
    if (event.published_at < event.created_at) {
      throw new TypeError(
        "outbox_event.published_at must be greater than or equal to created_at",
      );
    }
  }

  return event;
}

export function createTestBroadcast(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const broadcast = {
    id: randomUUID(),
    organization_id: randomUUID(),
    name: "Customer Re-engagement",
    status: "draft",
    template: { type: "text", body: "Hello, {{client.display_name}}" },
    filter: { tags: ["segment-a"] },
    schedule: {},
    rate_limit: { per_minute: 120 },
    created_by: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(broadcast.id, "broadcast.id");
  assertUuid(broadcast.organization_id, "broadcast.organization_id");
  assertNonBlankText(broadcast.name, "broadcast.name");
  if (!BROADCAST_STATUSES.includes(broadcast.status)) {
    throw new TypeError(
      `broadcast.status must be one of ${BROADCAST_STATUSES.join(", ")}`,
    );
  }
  assertJsonObject(broadcast.template, "broadcast.template");
  assertJsonObject(broadcast.filter, "broadcast.filter");
  assertJsonObject(broadcast.schedule, "broadcast.schedule");
  assertJsonObject(broadcast.rate_limit, "broadcast.rate_limit");
  if (broadcast.created_by !== null) {
    assertUuid(broadcast.created_by, "broadcast.created_by");
  }
  assertUtcTimestamptz(broadcast.created_at, "broadcast.created_at");
  assertUtcTimestamptz(broadcast.updated_at, "broadcast.updated_at");
  if (broadcast.updated_at < broadcast.created_at) {
    throw new TypeError("broadcast.updated_at must be greater than or equal to created_at");
  }

  return broadcast;
}

export function createTestBroadcastRecipient(overrides = {}) {
  const recipient = {
    id: randomUUID(),
    organization_id: randomUUID(),
    broadcast_id: randomUUID(),
    client_id: randomUUID(),
    endpoint_id: randomUUID(),
    status: "prepared",
    created_at: toUtcTimestamptz(),
    updated_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(recipient.id, "broadcast_recipient.id");
  assertUuid(recipient.organization_id, "broadcast_recipient.organization_id");
  assertUuid(recipient.broadcast_id, "broadcast_recipient.broadcast_id");
  assertUuid(recipient.client_id, "broadcast_recipient.client_id");
  assertUuid(recipient.endpoint_id, "broadcast_recipient.endpoint_id");
  if (!BROADCAST_DELIVERY_STATUSES.includes(recipient.status)) {
    throw new TypeError(
      `broadcast_recipient.status must be one of ${BROADCAST_DELIVERY_STATUSES.join(", ")}`,
    );
  }
  assertUtcTimestamptz(recipient.created_at, "broadcast_recipient.created_at");
  assertUtcTimestamptz(recipient.updated_at, "broadcast_recipient.updated_at");
  if (recipient.updated_at < recipient.created_at) {
    throw new TypeError(
      "broadcast_recipient.updated_at must be greater than or equal to created_at",
    );
  }

  return recipient;
}

export function createTestBroadcastMessage(overrides = {}) {
  const message = {
    id: randomUUID(),
    organization_id: randomUUID(),
    broadcast_id: randomUUID(),
    message_id: randomUUID(),
    status: "prepared",
    created_at: toUtcTimestamptz(),
    updated_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(message.id, "broadcast_message.id");
  assertUuid(message.organization_id, "broadcast_message.organization_id");
  assertUuid(message.broadcast_id, "broadcast_message.broadcast_id");
  assertUuid(message.message_id, "broadcast_message.message_id");
  if (!BROADCAST_DELIVERY_STATUSES.includes(message.status)) {
    throw new TypeError(
      `broadcast_message.status must be one of ${BROADCAST_DELIVERY_STATUSES.join(", ")}`,
    );
  }
  assertUtcTimestamptz(message.created_at, "broadcast_message.created_at");
  assertUtcTimestamptz(message.updated_at, "broadcast_message.updated_at");
  if (message.updated_at < message.created_at) {
    throw new TypeError(
      "broadcast_message.updated_at must be greater than or equal to created_at",
    );
  }

  return message;
}

export function createTestBroadcastStats(overrides = {}) {
  const stats = {
    broadcast_id: randomUUID(),
    organization_id: randomUUID(),
    prepared: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    updated_at: toUtcTimestamptz(),
    ...overrides,
  };

  assertUuid(stats.broadcast_id, "broadcast_stats.broadcast_id");
  assertUuid(stats.organization_id, "broadcast_stats.organization_id");
  assertNonNegativeInteger(stats.prepared, "broadcast_stats.prepared");
  assertNonNegativeInteger(stats.sent, "broadcast_stats.sent");
  assertNonNegativeInteger(stats.delivered, "broadcast_stats.delivered");
  assertNonNegativeInteger(stats.failed, "broadcast_stats.failed");
  assertUtcTimestamptz(stats.updated_at, "broadcast_stats.updated_at");

  return stats;
}

export function createTestNotification(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const notification = {
    id: randomUUID(),
    organization_id: randomUUID(),
    recipient_user_id: randomUUID(),
    category: "info",
    title: "New event",
    body: "A new platform event requires attention.",
    payload: {},
    status: "new",
    created_at: createdAt,
    read_at: null,
    ...overrides,
  };

  assertUuid(notification.id, "notification.id");
  assertUuid(notification.organization_id, "notification.organization_id");
  assertUuid(notification.recipient_user_id, "notification.recipient_user_id");
  if (!NOTIFICATION_CATEGORIES.includes(notification.category)) {
    throw new TypeError(
      `notification.category must be one of ${NOTIFICATION_CATEGORIES.join(", ")}`,
    );
  }
  assertNonBlankText(notification.title, "notification.title");
  assertNonBlankText(notification.body, "notification.body");
  assertJsonObject(notification.payload, "notification.payload");
  if (!NOTIFICATION_STATUSES.includes(notification.status)) {
    throw new TypeError(
      `notification.status must be one of ${NOTIFICATION_STATUSES.join(", ")}`,
    );
  }
  assertUtcTimestamptz(notification.created_at, "notification.created_at");
  if (notification.status === "read") {
    if (notification.read_at === null) {
      throw new TypeError("notification.read_at is required when status is read");
    }
  } else if (notification.read_at !== null) {
    throw new TypeError("notification.read_at must be null unless status is read");
  }
  if (notification.read_at !== null) {
    assertUtcTimestamptz(notification.read_at, "notification.read_at");
    if (notification.read_at < notification.created_at) {
      throw new TypeError(
        "notification.read_at must be greater than or equal to created_at",
      );
    }
  }

  return notification;
}

export function createTestNotificationSetting(overrides = {}) {
  const createdAt = overrides.created_at ?? toUtcTimestamptz();
  const setting = {
    id: randomUUID(),
    organization_id: randomUUID(),
    user_id: randomUUID(),
    category: "info",
    channel: "web",
    enabled: true,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };

  assertUuid(setting.id, "notification_setting.id");
  assertUuid(setting.organization_id, "notification_setting.organization_id");
  assertUuid(setting.user_id, "notification_setting.user_id");
  if (!NOTIFICATION_CATEGORIES.includes(setting.category)) {
    throw new TypeError(
      `notification_setting.category must be one of ${NOTIFICATION_CATEGORIES.join(", ")}`,
    );
  }
  if (!NOTIFICATION_CHANNELS.includes(setting.channel)) {
    throw new TypeError(
      `notification_setting.channel must be one of ${NOTIFICATION_CHANNELS.join(", ")}`,
    );
  }
  if (typeof setting.enabled !== "boolean") {
    throw new TypeError("notification_setting.enabled must be a boolean");
  }
  assertUtcTimestamptz(setting.created_at, "notification_setting.created_at");
  assertUtcTimestamptz(setting.updated_at, "notification_setting.updated_at");
  if (setting.updated_at < setting.created_at) {
    throw new TypeError(
      "notification_setting.updated_at must be greater than or equal to created_at",
    );
  }

  return setting;
}

export function createTestEdgeMessageBufferEntry(overrides = {}) {
  const receivedAt = overrides.received_at ?? toUtcTimestamptz();
  const ttl =
    overrides.ttl ??
    toUtcTimestamptz(new Date(new Date(receivedAt).getTime() + 60 * 60 * 1000));
  const entry = {
    id: randomUUID(),
    endpoint_id: randomUUID(),
    sequence_number: 1,
    idempotency_key: randomUUID(),
    payload_encrypted: Buffer.from("encrypted edge payload", "utf8"),
    received_at: receivedAt,
    ttl,
    forwarded_at: null,
    ...overrides,
  };

  assertUuid(entry.id, "edge_message_buffer.id");
  assertUuid(entry.endpoint_id, "edge_message_buffer.endpoint_id");
  assertPositiveInteger(entry.sequence_number, "edge_message_buffer.sequence_number");
  assertUuid(entry.idempotency_key, "edge_message_buffer.idempotency_key");
  if (!Buffer.isBuffer(entry.payload_encrypted) || entry.payload_encrypted.length === 0) {
    throw new TypeError("edge_message_buffer.payload_encrypted must be a non-empty Buffer");
  }
  assertUtcTimestamptz(entry.received_at, "edge_message_buffer.received_at");
  assertUtcTimestamptz(entry.ttl, "edge_message_buffer.ttl");
  if (entry.ttl < entry.received_at) {
    throw new TypeError("edge_message_buffer.ttl must be greater than or equal to received_at");
  }
  if (entry.forwarded_at !== null) {
    assertUtcTimestamptz(entry.forwarded_at, "edge_message_buffer.forwarded_at");
    if (entry.forwarded_at < entry.received_at) {
      throw new TypeError(
        "edge_message_buffer.forwarded_at must be greater than or equal to received_at",
      );
    }
  }

  return entry;
}
