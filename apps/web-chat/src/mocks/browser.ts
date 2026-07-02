import { setupWorker } from "msw/browser";
import { webChatMockHandlers } from "./handlers";

export const worker = setupWorker(...webChatMockHandlers);

export async function startWebChatMockServiceWorker() {
  await worker.start({
    onUnhandledRequest: "bypass",
    serviceWorker: {
      url: "/mockServiceWorker.js",
    },
  });
}
