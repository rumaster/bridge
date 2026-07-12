import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EdgeMaxSenderError, createEdgeMaxSender } from "../../src/edge-max-sender.js";

describe("edge MAX sender (M4)", () => {
  it("posts to /messages with the org token and chat_id, returns mid", async () => {
    const calls: any[] = [];
    const sender = createEdgeMaxSender({
      baseUrl: "https://max.test",
      fetchImpl: async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers });
        return new Response(JSON.stringify({ message: { body: { mid: "mid-out-1" } } }), { status: 200 });
      },
    });

    const result = await sender.send({
      organization_id: "org-1",
      message_id: "reply-1",
      channel_id: "chan-1",
      channel_type: "max",
      recipient_ref: "chat-1",
      text: "Заказ отправлен",
      credentials: { token: "tok-A" },
    });

    assert.equal(calls[0].url, "https://max.test/messages?access_token=tok-A&chat_id=chat-1");
    assert.deepEqual(calls[0].body, { text: "Заказ отправлен" });
    assert.equal(calls[0].headers["x-idempotency-key"], "reply-1");
    assert.equal(result.external_message_id, "mid-out-1");
    assert.equal(sender.getMetrics().sent_total, 1);
  });

  it("throws when no token is available", async () => {
    const sender = createEdgeMaxSender({
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });

    await assert.rejects(
      () =>
        sender.send({
          organization_id: "org-1",
          message_id: "r",
          channel_type: "max",
          recipient_ref: "chat-1",
          text: "x",
          credentials: {},
        }),
      EdgeMaxSenderError,
    );
  });

  it("throws when there is no recipient", async () => {
    const sender = createEdgeMaxSender({
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    await assert.rejects(
      () =>
        sender.send({
          organization_id: "org-1",
          message_id: "r",
          channel_type: "max",
          text: "x",
          credentials: { token: "tok-A" },
        }),
      EdgeMaxSenderError,
    );
  });

  it("throws EdgeMaxSenderError when the provider rejects delivery", async () => {
    const sender = createEdgeMaxSender({
      baseUrl: "https://max.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "chat.not_found", message: "chat not found" }), {
          status: 404,
        }),
    });

    await assert.rejects(
      () =>
        sender.send({
          organization_id: "org-1",
          message_id: "r",
          channel_type: "max",
          recipient_ref: "chat-x",
          text: "x",
          credentials: { token: "tok-A" },
        }),
      /chat not found/,
    );
    assert.equal(sender.getMetrics().failed_total, 1);
  });
});
