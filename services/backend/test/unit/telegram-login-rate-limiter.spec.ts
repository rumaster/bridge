import {
  TelegramLoginRateLimiter,
  requireTelegramLoginRateLimit,
} from "../../src/modules/identity/telegram-login-rate-limiter";

describe("TelegramLoginRateLimiter", () => {
  it("blocks a key until the rate-limit window resets", () => {
    let now = new Date("2026-07-04T12:00:00.000Z");
    const limiter = new TelegramLoginRateLimiter({
      limit: 2,
      now: () => now,
      windowSeconds: 60,
    });

    expect(limiter.hit("telegram:start:user:seeded_admin")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.hit("telegram:start:user:seeded_admin")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.hit("telegram:start:user:seeded_admin")).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    now = new Date("2026-07-04T12:01:01.000Z");
    expect(limiter.hit("telegram:start:user:seeded_admin")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("enforces the strictest key when user and IP limits are checked together", () => {
    const limiter = new TelegramLoginRateLimiter({
      limit: 1,
      now: () => new Date("2026-07-04T12:00:00.000Z"),
      windowSeconds: 30,
    });

    expect(
      requireTelegramLoginRateLimit(limiter, [
        "telegram:verify:request:req-1",
        "telegram:verify:ip:127.0.0.1",
      ]),
    ).toMatchObject({ allowed: true, remaining: 0 });

    expect(
      requireTelegramLoginRateLimit(limiter, [
        "telegram:verify:request:req-2",
        "telegram:verify:ip:127.0.0.1",
      ]),
    ).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    });
  });
});
