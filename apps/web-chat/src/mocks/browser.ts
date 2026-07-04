import { setupWorker } from "msw/browser";
import { setWebChatEdgeOutage, webChatMockHandlers } from "./handlers";

export const worker = setupWorker(...webChatMockHandlers);

declare global {
  interface Window {
    /**
     * Управление эмуляцией разрыва Edge для e2e CP-7 «Потеря соединения».
     * Доступно только при включённых dev-моках виджета.
     */
    __bridgeWebChatE2E?: {
      simulateEdgeOutage: () => void;
      restoreEdge: () => void;
    };
  }
}

export async function startWebChatMockServiceWorker() {
  await worker.start({
    onUnhandledRequest: "bypass",
    serviceWorker: {
      url: "/mockServiceWorker.js",
    },
  });

  if (typeof window !== "undefined") {
    window.__bridgeWebChatE2E = {
      simulateEdgeOutage: () => setWebChatEdgeOutage(true),
      restoreEdge: () => setWebChatEdgeOutage(false),
    };
  }
}
