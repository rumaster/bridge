import { createMobileApiServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3015", 10);
const host = process.env.HOST ?? "0.0.0.0";
const server = createMobileApiServer();

server.listen(port, host, () => {
  console.log(`mobile-api listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
