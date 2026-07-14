import { createC7WsRuntime } from "./c7-ws-runtime.js";

/**
 * Энтрипойнт standalone C7 WS-сервера App-стороны (см. c7-ws-runtime.ts). Поднимает
 * HTTP/WS-сервер и запускает Redis→WS мост. Слушает 0.0.0.0:PORT (по умолчанию
 * 3000) — manager-workspace проксирует сюда /api/v1/ws по docker-DNS.
 */
const runtime = await createC7WsRuntime({ env: process.env });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await new Promise<void>((resolve, reject) => {
  const onError = (error: unknown) => {
    runtime.server.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    runtime.server.off("error", onError);
    resolve();
  };
  runtime.server.once("error", onError);
  runtime.server.once("listening", onListening);
  runtime.server.listen(port, host);
});

runtime.start();

console.log(
  `c7-ws-server listening on http://${host}:${port} ` +
    `(stream=${runtime.stream} group=${runtime.group})`,
);

const shutdown = async () => {
  try {
    await runtime.close();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  } finally {
    process.exit(0);
  }
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
