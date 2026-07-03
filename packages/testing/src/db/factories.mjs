import { randomUUID } from "node:crypto";

import {
  assertNonBlankText,
  assertPositiveInteger,
  assertUtcTimestamptz,
  assertUuid,
  toUtcTimestamptz,
} from "./primitives.mjs";

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
