import { describe, expect, it } from "vitest";
import { mountBridgeWebChat } from "../src/embed";

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
});
