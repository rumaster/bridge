import { createDeterministicNotificationMock } from "./deterministic-notification.js";

export interface NotificationTriggerRedisClient {
  quit?(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
}

export interface NotificationTriggerStreamConsumerOptions {
  blockMs?: number;
  consumer?: string;
  count?: number;
  group?: string;
  notifications: ReturnType<typeof createDeterministicNotificationMock>;
  redis: NotificationTriggerRedisClient;
  stream?: string;
}

export interface NotificationTriggerStreamMessage {
  fields: Record<string, string>;
  id: string;
}

export interface ConsumedNotificationTrigger {
  id: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
}

export function createNotificationTriggerStreamConsumer({
  blockMs = 1_000,
  consumer = "svc-notif-1",
  count = 10,
  group = "svc-notif",
  notifications,
  redis,
  stream = "bridge:notifications:trigger",
}: NotificationTriggerStreamConsumerOptions) {
  return {
    async ensureConsumerGroup(): Promise<void> {
      try {
        await redis.sendCommand(["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"]);
      } catch (error) {
        if (!String(error instanceof Error ? error.message : error).includes("BUSYGROUP")) {
          throw error;
        }
      }
    },

    async pollOnce(): Promise<ConsumedNotificationTrigger[]> {
      const raw = await redis.sendCommand([
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
      const messages = parseRedisStreamMessages(raw);
      const consumed: ConsumedNotificationTrigger[] = [];

      for (const message of messages) {
        const rawPayload = message.fields.payload;
        if (!rawPayload) {
          throw new Error(`Redis Stream notification trigger ${message.id} has no payload field`);
        }
        const payload = parsePayload(rawPayload, message.id);
        const response = notifications.acceptProducerEvent(payload) as Record<string, unknown>;

        await redis.sendCommand(["XACK", stream, group, message.id]);
        consumed.push({ id: message.id, payload, response });
      }

      return consumed;
    },
  };
}

export async function connectNotificationTriggerRedis(
  url: string,
): Promise<NotificationTriggerRedisClient> {
  const { createClient } = await import("redis");
  const client = createClient({ url });
  client.on("error", (error) => {
    console.warn("notification-platform Redis Stream error", error);
  });
  await client.connect();
  return client as NotificationTriggerRedisClient;
}

export function parseRedisStreamMessages(raw: unknown): NotificationTriggerStreamMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const messages: NotificationTriggerStreamMessage[] = [];
  for (const streamEntry of raw) {
    if (!Array.isArray(streamEntry) || streamEntry.length < 2) {
      continue;
    }
    const records = streamEntry[1];
    if (!Array.isArray(records)) {
      continue;
    }

    for (const record of records) {
      if (!Array.isArray(record) || record.length < 2) {
        continue;
      }
      const id = toText(record[0]);
      const fields = normalizeFields(record[1]);
      if (id) {
        messages.push({ fields, id });
      }
    }
  }

  return messages;
}

function normalizeFields(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const fields: Record<string, string> = {};
    for (let index = 0; index < value.length; index += 2) {
      const key = toText(value[index]);
      if (!key) {
        continue;
      }
      fields[key] = toText(value[index + 1]);
    }
    return fields;
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, fieldValue]) => [
        toText(key),
        toText(fieldValue),
      ]),
    );
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [key, toText(fieldValue)]),
    );
  }

  return {};
}

function parsePayload(rawPayload: string, id: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      throw new Error("payload must be a JSON object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Redis Stream notification trigger ${id} has invalid payload: ${message}`);
  }
}

function toText(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return String(value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
