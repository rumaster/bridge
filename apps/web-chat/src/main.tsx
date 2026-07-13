import { mountBridgeWebChat } from "./embed";
import { resolveWebChatPageParams } from "./platform/pageContext";

/**
 * Точка входа хостируемой страницы организации (W5). Организация берётся из URL
 * (`/chat/<id>` или `?organization_id=`), а не из хардкода (WG-2). Без организации
 * страница показывает подсказку, а не молча грузит «дефолтную» организацию.
 */
const params = resolveWebChatPageParams(window.location);
const MOUNT_SELECTOR = "#bridge-web-chat-root";

if (params.organizationId) {
  void mountBridgeWebChat(MOUNT_SELECTOR, {
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    enableMockApi: import.meta.env.DEV && import.meta.env.VITE_WEB_CHAT_MOCKS === "true",
    edgeBaseUrl: import.meta.env.VITE_BRIDGE_EDGE_BASE_URL || "/api/v1",
    realtimeReconnectDelayMs: 400,
  });
} else {
  renderMissingOrganization();
}

function renderMissingOrganization(): void {
  const root = document.querySelector(MOUNT_SELECTOR);
  if (!root) {
    return;
  }
  root.textContent =
    "Организация не указана. Откройте страницу как /chat/<идентификатор организации>.";
  root.setAttribute("role", "alert");
  root.setAttribute("data-web-chat-state", "missing-organization");
}
