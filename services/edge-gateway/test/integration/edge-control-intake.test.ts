import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createEdgeGatewayServer } from "../../src/server.js";

/**
 * Проверка control-intake эндпоинта Edge (Этап M5): App→Edge control-сообщения
 * (`/internal/edge/control/messages`) доходят до control-plane, когда рантайм
 * собрал канальные драйверы (передан controlPlane).
 */

describe("edge control intake route (M5)", () => {
  let server: any;
  let baseUrl: string;
  const handled: any[] = [];

  const controlPlane = {
    async handle(message: any) {
      if (message?.type === "boom") {
        throw new Error("rejected control message");
      }
      handled.push(message);
      return { accepted: true, control_id: message?.control_id, status: "stored" };
    },
  };

  before(async () => {
    server = createEdgeGatewayServer({ controlPlane });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error: any) => (error ? reject(error) : resolve())),
    );
  });

  it("forwards a control message to the control-plane and returns its ack", async () => {
    const response = await fetch(`${baseUrl}/internal/edge/control/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "channel_credentials_sync", control_id: "ctl-1" }),
    });

    assert.equal(response.status, 202);
    const ack = (await response.json()) as { status?: string; control_id?: string };
    assert.equal(ack.status, "stored");
    assert.equal(ack.control_id, "ctl-1");
    assert.equal(handled.length, 1);
  });

  it("returns 400 when the control-plane rejects the message", async () => {
    const response = await fetch(`${baseUrl}/internal/edge/control/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "boom", control_id: "ctl-2" }),
    });

    assert.equal(response.status, 400);
  });

  it("does not expose the control route when no control-plane is wired", async () => {
    const bareServer: any = createEdgeGatewayServer({});
    await new Promise((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
    const bareUrl = `http://127.0.0.1:${bareServer.address().port}`;

    const response = await fetch(`${bareUrl}/internal/edge/control/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "channel_credentials_sync", control_id: "ctl-3" }),
    });

    assert.equal(response.status, 404, "control route absent without a control-plane");
    await new Promise<void>((resolve, reject) =>
      bareServer.close((error: any) => (error ? reject(error) : resolve())),
    );
  });
});
