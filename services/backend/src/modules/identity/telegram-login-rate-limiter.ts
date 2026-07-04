export interface TelegramLoginRateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface TelegramLoginRateLimiterOptions {
  limit: number;
  now?: () => Date;
  windowSeconds: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class TelegramLoginRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly windowMs: number;

  constructor(options: TelegramLoginRateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(options.limit));
    this.now = options.now ?? (() => new Date());
    this.windowMs = Math.max(1, Math.floor(options.windowSeconds)) * 1000;
  }

  hit(key: string): TelegramLoginRateLimitDecision {
    const currentTime = this.now().getTime();
    const bucket = this.buckets.get(key);

    if (!bucket || currentTime >= bucket.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: currentTime + this.windowMs,
      });

      return {
        allowed: true,
        remaining: this.limit - 1,
        retryAfterSeconds: 0,
      };
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((bucket.resetAt - currentTime) / 1000),
      };
    }

    bucket.count += 1;

    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      retryAfterSeconds: 0,
    };
  }
}

export function requireTelegramLoginRateLimit(
  limiter: TelegramLoginRateLimiter,
  keys: string[],
): TelegramLoginRateLimitDecision {
  const uniqueKeys = [...new Set(keys.filter((key) => key.trim() !== ""))];
  let strictestDecision: TelegramLoginRateLimitDecision = {
    allowed: true,
    remaining: Number.MAX_SAFE_INTEGER,
    retryAfterSeconds: 0,
  };

  for (const key of uniqueKeys) {
    const decision = limiter.hit(key);
    if (!decision.allowed) {
      return decision;
    }
    if (decision.remaining < strictestDecision.remaining) {
      strictestDecision = decision;
    }
  }

  return strictestDecision;
}

export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
