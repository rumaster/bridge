import { createClient } from "redis";

export interface RedisCommandClient {
  sendCommand(args: string[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface RedisCacheOptions {
  ttlSeconds?: number;
}

export class RedisInfrastructure {
  constructor(private readonly client: RedisCommandClient) {}

  static async connect(url: string): Promise<RedisInfrastructure> {
    const client = createClient({ url });
    client.on("error", (error) => {
      console.warn(`Redis client error: ${error instanceof Error ? error.message : error}`);
    });
    await client.connect();
    return new RedisInfrastructure(client);
  }

  async setCache(
    key: string,
    value: string,
    options: RedisCacheOptions = {},
  ): Promise<void> {
    const command = ["SET", key, value];
    if (options.ttlSeconds && options.ttlSeconds > 0) {
      command.push("EX", String(options.ttlSeconds));
    }
    await this.client.sendCommand(command);
  }

  async getCache(key: string): Promise<string | null> {
    const value = await this.client.sendCommand(["GET", key]);
    return typeof value === "string" ? value : null;
  }

  async ensureConsumerGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.sendCommand(["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"]);
    } catch (error) {
      if (!isBusyGroupError(error)) {
        throw error;
      }
    }
  }

  async publishStream(
    stream: string,
    fields: Record<string, string | number | boolean>,
  ): Promise<string> {
    const command = ["XADD", stream, "*"];
    for (const [key, value] of Object.entries(fields)) {
      command.push(key, String(value));
    }

    const id = await this.client.sendCommand(command);
    if (typeof id !== "string") {
      throw new Error(`Redis XADD returned a non-string id for ${stream}`);
    }
    return id;
  }

  async readGroup({
    stream,
    group,
    consumer,
    count = 1,
    blockMs = 1000,
  }: {
    stream: string;
    group: string;
    consumer: string;
    count?: number;
    blockMs?: number;
  }): Promise<unknown> {
    return this.client.sendCommand([
      "XREADGROUP",
      "GROUP",
      group,
      consumer,
      "COUNT",
      String(count),
      "BLOCK",
      String(blockMs),
      "STREAMS",
      stream,
      ">",
    ]);
  }

  async close(): Promise<void> {
    await this.client.quit?.();
  }
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}
