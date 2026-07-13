import { Injectable } from "@nestjs/common";

/**
 * Лёгкий in-memory rate-limiter публичных Web Chat-ручек (W4, WG-11,
 * docs/plan/web-chat-channel-production.md). Фиксированное окно на ключ
 * (organization + источник). Без внешних зависимостей (throttler не подключён);
 * для боевого мультиинстансного профиля выносится в Redis отдельным шагом.
 */
export interface RateLimitRule {
  /** Максимум запросов за окно. */
  limit: number;
  /** Длина окна в миллисекундах. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 50_000;

@Injectable()
export class WebChatRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Учитывает запрос по ключу. Возвращает true, если он в пределах лимита; false —
   * если лимит исчерпан в текущем окне.
   */
  tryConsume(key: string, rule: RateLimitRule, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      this.pruneIfNeeded(now);
      return true;
    }
    if (bucket.count >= rule.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  private pruneIfNeeded(now: number): void {
    if (this.buckets.size < MAX_BUCKETS) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}
