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
  root.render(<WebChatWidget {...resolveOptionsFromElement(element, options)} />);

  return {
    element,
    unmount() {
      root.unmount();
      mountedRoots.delete(element);
    },
  };
}

/**
 * Встраивание без JS-опций (W5, WG-2, задача 3): если organization/conversation не
 * заданы в опциях mount, берём их из data-атрибутов точки монтирования —
 * `<div data-organization-id="..." data-conversation-id="...">`.
 */
export function resolveOptionsFromElement(
  element: HTMLElement,
  options: WebChatMountOptions,
): WebChatMountOptions {
  const next: WebChatMountOptions = { ...options };
  if (!next.organizationId) {
    const organizationId = element.dataset?.organizationId?.trim();
    if (organizationId) {
      next.organizationId = organizationId;
    }
  }
  if (!next.conversationId) {
    const conversationId = element.dataset?.conversationId?.trim();
    if (conversationId) {
      next.conversationId = conversationId;
    }
  }
  return next;
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
