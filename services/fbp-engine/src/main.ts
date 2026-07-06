import { createFbpEngineServer } from "./server.js";
import { createHttpBackendApiClient } from "./backend/client.js";
import { startFbpEngineGrpcServer } from "./grpc-server.js";

const port = Number.parseInt(process.env.PORT ?? "3095", 10);
const grpcPort = Number.parseInt(process.env.FBP_GRPC_PORT ?? "3105", 10);
const host = process.env.HOST ?? "0.0.0.0";
const backendApiUrl = process.env.FBP_BACKEND_API_URL?.trim();

const server = createFbpEngineServer();
const grpcHandle = await startFbpEngineGrpcServer({
  backendClient: backendApiUrl
    ? createHttpBackendApiClient({ baseUrl: backendApiUrl })
    : createUnavailableBackendClient(),
  host,
  port: grpcPort,
});

server.listen(port, host, () => {
  console.log(`FBP Engine C5 compatibility HTTP listening on http://${host}:${port}`);
  console.log(`FBP Engine gRPC listening on ${grpcHandle.address}`);
});

function createUnavailableBackendClient() {
  return {
    async call() {
      throw new Error("FBP_BACKEND_API_URL is not configured for backend-api Workflow nodes.");
    },
  };
}
