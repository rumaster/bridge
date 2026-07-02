import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSyncCursor,
  parseSyncCursor,
} from "../../src/sync-cursor.mjs";

describe("mobile sync cursor format", () => {
  it("creates and parses mob1 base64url cursors", () => {
    const cursor = createSyncCursor({
      organizationId: "org-1",
      userId: "manager-1",
      deviceId: "device-1",
      sequence: 42,
      issuedAt: "2026-07-02T16:30:00.000Z",
    });
    const parsed = parseSyncCursor(cursor);

    assert.match(cursor, /^mob1\.[A-Za-z0-9_-]+$/);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, {
      v: 1,
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "device-1",
      sequence: 42,
      issued_at: "2026-07-02T16:30:00.000Z",
    });
  });

  it("rejects malformed or non-monotonic cursor payloads", () => {
    const malformed = parseSyncCursor("mob1.not-json");

    assert.equal(malformed.ok, false);
    assert.throws(
      () =>
        createSyncCursor({
          organizationId: "org-1",
          userId: "manager-1",
          deviceId: "device-1",
          sequence: -1,
          issuedAt: "2026-07-02T16:30:00.000Z",
        }),
      /sequence/,
    );
  });
});
