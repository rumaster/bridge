import { createNotificationPlatformServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3010", 10);
const host = process.env.HOST ?? "0.0.0.0";
const server = createNotificationPlatformServer();

server.listen(port, host, () => {
  console.log(`notification-platform M0 mock listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
