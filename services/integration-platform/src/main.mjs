import { createMockAdapter } from "./adapters/mock/mock-adapter.mjs";
import { createIntegrationPlatformServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3005", 10);
const host = process.env.HOST ?? "0.0.0.0";
const coreIngressUrl =
  process.env.CORE_INGRESS_URL ?? "http://127.0.0.1:3000/internal/ingress/messages";

const adapter = createMockAdapter({ coreIngressUrl });
const server = createIntegrationPlatformServer({ adapter });

server.listen(port, host, () => {
  console.log(`integration-platform listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
