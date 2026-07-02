import { createRoot, type Root } from "react-dom/client";
import { WebChatWidget } from "./WebChatWidget";
import type { WebChatInstance, WebChatMountOptions } from "./types";
import "./style.css";

const mountedRoots = new WeakMap<HTMLElement, Root>();

export async function renderWebChatWidget(
  target: HTMLElement | string,
  options: WebChatMountOptions = {},
): Promise<WebChatInstance> {
  const element = resolveMountTarget(target);

  if (options.enableMockApi) {
    const { startWebChatMockServiceWorker } = await import("./mocks/browser");
    await startWebChatMockServiceWorker();
  }

  mountedRoots.get(element)?.unmount();

  const root = createRoot(element);
  mountedRoots.set(element, root);
  root.render(<WebChatWidget {...options} />);

  return {
    element,
    unmount() {
      root.unmount();
      mountedRoots.delete(element);
    },
  };
}

function resolveMountTarget(target: HTMLElement | string): HTMLElement {
  if (typeof target !== "string") {
    return target;
  }

  const element = document.querySelector<HTMLElement>(target);
  if (!element) {
    throw new Error(`Bridge Web Chat mount point not found: ${target}`);
  }

  return element;
}
