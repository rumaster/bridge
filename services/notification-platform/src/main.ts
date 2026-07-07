import { createDeterministicNotificationMock } from "./deterministic-notification.js";
import { startNotificationPlatformGrpcServer } from "./grpc-server.js";
import {
  connectNotificationTriggerRedis,
  createNotificationTriggerStreamConsumer,
} from "./notification-trigger-stream.js";
import { createNotificationPlatformServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3010", 10);
const grpcPort = parsePort(process.env.NOTIFICATION_GRPC_PORT, 3110);
const host = process.env.HOST ?? "0.0.0.0";
const grpcHost = process.env.NOTIFICATION_GRPC_HOST ?? host;
const notifications = createDeterministicNotificationMock();
const server = createNotificationPlatformServer({ notifications });
const grpcHandle = await startNotificationPlatformGrpcServer({
  host: grpcHost,
  notifications,
  port: grpcPort,
});
const streamRuntime = await createNotificationStreamRuntime();

server.listen(port, host, () => {
  console.log(`notification-platform listening on http://${host}:${port}`);
  console.log(`notification-platform gRPC listening on ${grpcHandle.address}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}

async function createNotificationStreamRuntime() {
  const redisUrl = process.env.NOTIFICATION_REDIS_URL ?? process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  const redis = await connectNotificationTriggerRedis(redisUrl);
  const consumer = createNotificationTriggerStreamConsumer({
    consumer: process.env.NOTIFICATION_TRIGGER_CONSUMER ?? `svc-notif-${process.pid}`,
    group: process.env.NOTIFICATION_TRIGGER_GROUP ?? "svc-notif",
    notifications,
    redis,
    stream: process.env.NOTIFICATION_TRIGGER_STREAM ?? "bridge:notifications:trigger",
  });
  await consumer.ensureConsumerGroup();

  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await consumer.pollOnce();
      } catch (error) {
        console.warn("notification-platform Redis Stream polling failed", error);
        await sleep(1_000);
      }
    }
  };

  void loop();

  return {
    async close() {
      stopped = true;
      await redis.quit?.();
    },
  };
}

async function shutdown() {
  await Promise.all([
    closeHttpServer(),
    closeGrpcServer(),
    streamRuntime?.close() ?? Promise.resolve(),
  ]);
}

function closeHttpServer() {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose(undefined));
  });
}

function closeGrpcServer() {
  return new Promise((resolveClose) => {
    grpcHandle.server.tryShutdown(() => resolveClose(undefined));
  });
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
