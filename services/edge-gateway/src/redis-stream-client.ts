import type { C7RedisStreamClient } from "./c7-redis-stream-bridge.js";

export async function createRedisStreamClient(url: string): Promise<C7RedisStreamClient> {
  const { createClient } = await loadRedis();
  const client = createClient({ url });
  client.on("error", (error) => {
    console.warn(`Redis client error: ${error instanceof Error ? error.message : error}`);
  });
  await client.connect();

  return {
    async ensureConsumerGroup(stream, group) {
      try {
        await client.sendCommand(["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"]);
      } catch (error) {
        if (!isBusyGroupError(error)) {
          throw error;
        }
      }
    },
    readGroup({ stream, group, consumer, count = 10, blockMs = 1_000 }) {
      return client.sendCommand([
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
    },
    ack(stream, group, id) {
      return client.sendCommand(["XACK", stream, group, id]);
    },
    close() {
      return client.quit();
    },
  };
}

async function loadRedis(): Promise<{ createClient: (options: { url: string }) => any }> {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  return dynamicImport("redis");
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}
