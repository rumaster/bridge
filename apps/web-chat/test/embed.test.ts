import { describe, expect, it } from "vitest";
import { mountBridgeWebChat } from "../src/embed";
import { resolveOptionsFromElement } from "../src/bootstrap";

describe("Bridge Web Chat embed loader", () => {
  it("публикует ленивый mount API в window", () => {
    expect(window.BridgeWebChat?.mount).toBe(mountBridgeWebChat);
  });

  it("монтирует виджет по CSS-селектору", async () => {
    const mountPoint = document.createElement("div");
    mountPoint.id = "bridge-web-chat-test-root";
    document.body.append(mountPoint);

    const instance = await mountBridgeWebChat("#bridge-web-chat-test-root", {
      apiBaseUrl: "http://localhost/api/v1",
    });

    expect(instance.element).toBe(mountPoint);
    instance.unmount();
  });

  it("берёт organization/conversation из data-атрибутов при встраивании (W5)", () => {
    const element = document.createElement("div");
    element.dataset.organizationId = "org-attr";
    element.dataset.conversationId = "conv-attr";

    const resolved = resolveOptionsFromElement(element, {});
    expect(resolved.organizationId).toBe("org-attr");
    expect(resolved.conversationId).toBe("conv-attr");
  });

  it("JS-опции имеют приоритет над data-атрибутами", () => {
    const element = document.createElement("div");
    element.dataset.organizationId = "org-attr";

    const resolved = resolveOptionsFromElement(element, { organizationId: "org-opt" });
    expect(resolved.organizationId).toBe("org-opt");
  });
});
