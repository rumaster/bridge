import { createDeterministicBroadcastMock } from "./deterministic-broadcast.js";
import { startBroadcastPlatformGrpcServer } from "./grpc-server.js";
import { createBroadcastPlatformServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3008", 10);
const grpcPort = parsePort(process.env.BROADCAST_GRPC_PORT, 3108);
const host = process.env.HOST ?? "0.0.0.0";
const grpcHost = process.env.BROADCAST_GRPC_HOST ?? host;
const broadcast = createDeterministicBroadcastMock();
const server = createBroadcastPlatformServer({ broadcast });
const grpcHandle = await startBroadcastPlatformGrpcServer({
  broadcast,
  host: grpcHost,
  port: grpcPort,
});

server.listen(port, host, () => {
  console.log(`broadcast-platform listening on http://${host}:${port}`);
  console.log(`broadcast-platform gRPC listening on ${grpcHandle.address}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}

async function shutdown() {
  await Promise.all([closeHttpServer(), closeGrpcServer()]);
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

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
