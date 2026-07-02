import { mountBridgeWebChat } from "./embed";

void mountBridgeWebChat("#bridge-web-chat-root", {
  enableMockApi: import.meta.env.DEV,
});
