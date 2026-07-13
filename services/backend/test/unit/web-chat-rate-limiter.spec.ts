import { WebChatRateLimiter } from "../../src/modules/web-chat/web-chat-rate-limiter";

/**
 * In-memory rate-limiter публичных Web Chat-ручек (W4, WG-11,
 * docs/plan/web-chat-channel-production.md).
 */
describe("WebChatRateLimiter", () => {
  const rule = { limit: 3, windowMs: 1000 };

  it("пропускает запросы в пределах лимита и режет сверх лимита", () => {
    const limiter = new WebChatRateLimiter();
    const now = 1_000_000;
    expect(limiter.tryConsume("k", rule, now)).toBe(true);
    expect(limiter.tryConsume("k", rule, now)).toBe(true);
    expect(limiter.tryConsume("k", rule, now)).toBe(true);
    expect(limiter.tryConsume("k", rule, now)).toBe(false); // 4-й в том же окне
  });

  it("сбрасывает счётчик в новом окне", () => {
    const limiter = new WebChatRateLimiter();
    const start = 2_000_000;
    for (let i = 0; i < 3; i += 1) {
      limiter.tryConsume("k", rule, start);
    }
    expect(limiter.tryConsume("k", rule, start)).toBe(false);
    expect(limiter.tryConsume("k", rule, start + rule.windowMs)).toBe(true);
  });

  it("считает ключи независимо", () => {
    const limiter = new WebChatRateLimiter();
    const now = 3_000_000;
    for (let i = 0; i < 3; i += 1) {
      limiter.tryConsume("a", rule, now);
    }
    expect(limiter.tryConsume("a", rule, now)).toBe(false);
    expect(limiter.tryConsume("b", rule, now)).toBe(true);
  });
});
