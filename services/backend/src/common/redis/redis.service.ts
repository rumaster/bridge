import { Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";

import { RedisInfrastructure, type RedisCacheOptions } from "./redis.infrastructure";

@Injectable()
export class RedisInfrastructureService implements OnModuleDestroy {
  private infrastructure?: Promise<RedisInfrastructure>;

  isConfigured(): boolean {
    return Boolean(redisUrl());
  }

  async setCache(
    key: string,
    value: string,
    options: RedisCacheOptions = {},
  ): Promise<void> {
    await (await this.getInfrastructure()).setCache(key, value, options);
  }

  async getCache(key: string): Promise<string | null> {
    return (await this.getInfrastructure()).getCache(key);
  }

  async ensureConsumerGroup(stream: string, group: string): Promise<void> {
    await (await this.getInfrastructure()).ensureConsumerGroup(stream, group);
  }

  async publishStream(
    stream: string,
    fields: Record<string, string | number | boolean>,
  ): Promise<string> {
    return (await this.getInfrastructure()).publishStream(stream, fields);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.infrastructure) {
      await (await this.infrastructure).close();
    }
  }

  private getInfrastructure(): Promise<RedisInfrastructure> {
    if (this.infrastructure) {
      return this.infrastructure;
    }

    const url = redisUrl();
    if (!url) {
      throw new ServiceUnavailableException({
        code: "REDIS_UNAVAILABLE",
        description: "REDIS_URL is not configured",
        humanMessage: "Redis недоступен.",
      });
    }

    this.infrastructure = RedisInfrastructure.connect(url);
    return this.infrastructure;
  }
}

function redisUrl(): string | null {
  const value = process.env.REDIS_URL?.trim();
  return value ? value : null;
}
