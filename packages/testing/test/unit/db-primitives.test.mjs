import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestOrganization, createTestUser } from "../../src/db/factories.mjs";
import {
  assertUtcTimestamptz,
  assertUuid,
  isUtcTimestamptz,
  isUuid,
  toUtcTimestamptz,
} from "../../src/db/primitives.mjs";

describe("db primitive validators", () => {
  it("accepts RFC 4122 UUID values and rejects malformed values", () => {
    assert.equal(isUuid("00000000-0000-4000-8000-000000000001"), true);
    assert.equal(isUuid("00000000-0000-0000-0000-000000000001"), false);
    assert.equal(isUuid("not-a-uuid"), false);

    assert.equal(assertUuid("00000000-0000-4000-8000-000000000002"), "00000000-0000-4000-8000-000000000002");
    assert.throws(() => assertUuid("not-a-uuid"), /must be an RFC 4122 UUID/);
  });

  it("normalizes and validates UTC timestamptz strings", () => {
    assert.equal(toUtcTimestamptz("2026-01-01T03:00:00.000+03:00"), "2026-01-01T00:00:00.000Z");
    assert.equal(isUtcTimestamptz("2026-01-01T00:00:00.000Z"), true);
    assert.equal(isUtcTimestamptz("2026-01-01T00:00:00+00:00"), false);
    assert.equal(isUtcTimestamptz("not-a-date"), false);

    assert.equal(assertUtcTimestamptz("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
    assert.throws(() => assertUtcTimestamptz("2026-01-01T00:00:00+00:00"), /ISO 8601 UTC/);
  });
});

describe("db test factories", () => {
  it("creates organization and user fixtures with valid UUID and UTC timestamps", () => {
    const organization = createTestOrganization();
    const user = createTestUser({ organization_id: organization.id });

    assert.equal(isUuid(organization.id), true);
    assert.equal(isUtcTimestamptz(organization.created_at), true);
    assert.equal(isUuid(user.id), true);
    assert.equal(user.organization_id, organization.id);
    assert.equal(isUtcTimestamptz(user.created_at), true);
  });
});
