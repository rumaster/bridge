import { createAiPlatformServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3006", 10);
const host = process.env.HOST ?? "0.0.0.0";
const server = createAiPlatformServer();

server.listen(port, host, () => {
  console.log(`ai-platform listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
