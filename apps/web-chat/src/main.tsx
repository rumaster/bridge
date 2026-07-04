import { mountBridgeWebChat } from "./embed";

const params = new URLSearchParams(window.location.search);
// Демо/e2e: ?edge=1 включает прозрачную маршрутизацию через Edge Cluster (CP-7),
// чтобы воспроизвести подключение клиентов РФ и сценарий «Потеря соединения».
const viaEdge = params.get("edge") === "1";

void mountBridgeWebChat("#bridge-web-chat-root", {
  enableMockApi: import.meta.env.DEV,
  edgeBaseUrl: viaEdge ? "/edge/api/v1" : undefined,
  realtimeReconnectDelayMs: viaEdge ? 400 : undefined,
});
