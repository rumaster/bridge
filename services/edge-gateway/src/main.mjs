import { createEdgeGatewayServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const server = createEdgeGatewayServer();

server.listen(port, host, () => {
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  console.log(`edge-gateway M0 mock listening on http://${host}:${resolvedPort}`);
});
