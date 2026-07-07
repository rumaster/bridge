export interface C7RedisStreamClient {
  ack(stream: string, group: string, id: string): Promise<unknown>;
  close?: () => Promise<unknown>;
  ensureConsumerGroup(stream: string, group: string): Promise<unknown>;
  readGroup(input: {
    stream: string;
    group: string;
    consumer: string;
    count?: number;
    blockMs?: number;
  }): Promise<unknown>;
}

export interface CreateC7RedisStreamBridgeOptions {
  stream?: string;
  group?: string;
  consumer?: string;
  count?: number;
  pollMs?: number;
  streamClient: C7RedisStreamClient;
  wsChannel: {
    publish(event: unknown): unknown;
  };
  logger?: Pick<Console, "error" | "warn">;
}

const DEFAULT_STREAM = "bridge:c7:events";
const DEFAULT_GROUP = "edge-gateway-c7";

export function createC7RedisStreamBridge({
  stream = DEFAULT_STREAM,
  group = DEFAULT_GROUP,
  consumer = `edge-gateway-${process.pid}`,
  count = 10,
  pollMs = 1_000,
  streamClient,
  wsChannel,
  logger = console,
}: CreateC7RedisStreamBridgeOptions) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let groupReady: Promise<unknown> | null = null;

  async function ensureGroup() {
    groupReady ??= streamClient.ensureConsumerGroup(stream, group);
    await groupReady;
  }

  async function pollOnce() {
    await ensureGroup();
    const response = await streamClient.readGroup({
      stream,
      group,
      consumer,
      count,
      blockMs: pollMs,
    });

    for (const message of parseRedisStreamResponse(response)) {
      try {
        const event = parseC7Event(message.fields);
        if (!event) {
          logger.warn(`Skipping Redis Stream message ${message.id}: missing event field`);
          await streamClient.ack(stream, group, message.id);
          continue;
        }
        wsChannel.publish(event);
        await streamClient.ack(stream, group, message.id);
      } catch (error) {
        logger.error(
          `C7 Redis Stream message ${message.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function schedule(delay = pollMs) {
    if (!running || timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void runLoop();
    }, Math.max(0, delay));
  }

  async function runLoop() {
    if (!running || inFlight) {
      return;
    }
    inFlight = pollOnce();
    try {
      await inFlight;
    } catch (error) {
      logger.error(
        `C7 Redis Stream poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight = null;
      schedule();
    }
  }

  return {
    pollOnce,
    start() {
      if (running) {
        return;
      }
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      await streamClient.close?.();
    },
  };
}

function parseRedisStreamResponse(response: unknown): Array<{
  id: string;
  fields: Record<string, string>;
}> {
  if (!Array.isArray(response)) {
    return [];
  }

  const messages: Array<{ id: string; fields: Record<string, string> }> = [];
  for (const streamEntry of response) {
    if (!Array.isArray(streamEntry) || streamEntry.length < 2 || !Array.isArray(streamEntry[1])) {
      continue;
    }

    for (const rawMessage of streamEntry[1]) {
      if (!Array.isArray(rawMessage) || rawMessage.length < 2 || typeof rawMessage[0] !== "string") {
        continue;
      }
      messages.push({
        id: rawMessage[0],
        fields: normalizeFields(rawMessage[1]),
      });
    }
  }

  return messages;
}

function normalizeFields(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const fields: Record<string, string> = {};
    for (let index = 0; index < value.length; index += 2) {
      const key = normalizeString(value[index]);
      const fieldValue = normalizeString(value[index + 1]);
      if (key !== null && fieldValue !== null) {
        fields[key] = fieldValue;
      }
    }
    return fields;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entryValue]) => [key, normalizeString(entryValue)])
        .filter((entry): entry is [string, string] => entry[1] !== null),
    );
  }

  return {};
}

function parseC7Event(fields: Record<string, string>): unknown | null {
  const rawEvent = fields.event;
  if (!rawEvent) {
    return null;
  }

  try {
    return JSON.parse(rawEvent);
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
