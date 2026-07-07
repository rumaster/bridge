import { mountBridgeWebChat } from "./embed";

void mountBridgeWebChat("#bridge-web-chat-root", {
  enableMockApi: import.meta.env.DEV && import.meta.env.VITE_WEB_CHAT_MOCKS === "true",
  edgeBaseUrl: import.meta.env.VITE_BRIDGE_EDGE_BASE_URL || "/api/v1",
  realtimeReconnectDelayMs: 400,
});
