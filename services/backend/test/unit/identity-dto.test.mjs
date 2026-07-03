import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateTelegramLoginStartRequest,
  validateTelegramLoginVerifyRequest,
} from "../../src/modules/identity/dto/auth-dto.mjs";

describe("identity DTO validation", () => {
  it("accepts a valid Telegram login start payload", () => {
    const result = validateTelegramLoginStartRequest({
      telegramUsername: "seeded_admin",
    });

    assert.deepEqual(result, {
      ok: true,
      value: {
        telegramUsername: "seeded_admin",
      },
    });
  });

  it("normalizes a Telegram username with @ prefix", () => {
    const result = validateTelegramLoginStartRequest({
      telegramUsername: "@Seeded_Admin",
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.telegramUsername, "seeded_admin");
  });

  it("rejects invalid Telegram usernames", () => {
    const result = validateTelegramLoginStartRequest({
      telegramUsername: "no spaces",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, "telegramUsername");
  });

  it("accepts a valid Telegram verify payload", () => {
    const result = validateTelegramLoginVerifyRequest({
      telegramUsername: "seeded_admin",
      code: "123456",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      telegramUsername: "seeded_admin",
      requestId: null,
      code: "123456",
    });
  });

  it("accepts a valid Telegram verify payload by requestId", () => {
    const result = validateTelegramLoginVerifyRequest({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      code: "123456",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      telegramUsername: null,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      code: "123456",
    });
  });

  it("rejects malformed verification code", () => {
    const result = validateTelegramLoginVerifyRequest({
      telegramUsername: "seeded_admin",
      code: "abc123",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, "code");
  });
});
