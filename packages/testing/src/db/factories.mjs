import { randomUUID } from "node:crypto";

import { assertUtcTimestamptz, assertUuid, toUtcTimestamptz } from "./primitives.mjs";

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
