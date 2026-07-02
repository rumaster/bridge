import type { WebChatInstance, WebChatMountOptions } from "./types";

export async function mountBridgeWebChat(
  target: HTMLElement | string,
  options: WebChatMountOptions = {},
): Promise<WebChatInstance> {
  const { renderWebChatWidget } = await import("./bootstrap");
  return renderWebChatWidget(target, options);
}

declare global {
  interface Window {
    BridgeWebChat?: {
      mount: typeof mountBridgeWebChat;
    };
  }
}

if (typeof window !== "undefined") {
  window.BridgeWebChat = {
    mount: mountBridgeWebChat,
  };
}
