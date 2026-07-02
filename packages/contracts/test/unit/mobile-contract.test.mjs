import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MOBILE_API_BASE_PATH,
  MOBILE_API_CONTRACT_ID,
  MOBILE_API_OPENAPI,
  MOBILE_API_VERSION,
  MOBILE_CONSUMER_CONTRACTS,
  isMobileSyncCursor,
} from "../../src/mobile.mjs";

describe("MOBILE.v1 contract exports", () => {
  it("exports independent semver and OpenAPI metadata", () => {
    assert.equal(MOBILE_API_VERSION, "1.0.0");
    assert.equal(MOBILE_API_BASE_PATH, "/mobile/v1");
    assert.equal(MOBILE_API_CONTRACT_ID, "MOBILE.v1");
    assert.equal(MOBILE_API_OPENAPI.info.version, "1.0.0");
    assert.equal(MOBILE_API_OPENAPI["x-owner"], "SVC-MOB");
  });

  it("exports mobile consumer contract stubs", () => {
    const interactionIds = MOBILE_CONSUMER_CONTRACTS.interactions.map(
      (interaction) => interaction.id,
    );

    assert.equal(MOBILE_CONSUMER_CONTRACTS.version, "1.0.0");
    assert.ok(interactionIds.includes("mobile-app-svc-mob-sync"));
    assert.ok(interactionIds.includes("svc-mob-consumes-c10-notifications"));
  });

  it("recognizes the frozen cursor format shape", () => {
    assert.equal(isMobileSyncCursor("mob1.abc_DEF-123"), true);
    assert.equal(isMobileSyncCursor("api1.abc"), false);
  });
});
