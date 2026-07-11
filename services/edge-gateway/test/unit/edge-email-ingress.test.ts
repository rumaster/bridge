import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NonIngestibleEmailError, buildEmailIngress } from "../../src/edge-email-ingress.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
const now = () => "2026-07-11T10:00:00.000Z";

describe("edge email ingress builder", () => {
  it("normalizes a text email into a C2.IngressMessage envelope with edge fields", () => {
    const body = buildEmailIngress({
      email: {
        uid: 5,
        message_id: "<abc@mail.example.com>",
        from: "client@example.com",
        subject: "Вопрос по заказу",
        text: "Здравствуйте, где мой заказ?",
        thread_id: "thread-42",
        date: "2026-07-11T09:59:00.000Z",
      },
      organizationId: "org-1",
      channelId: "chan-1",
      now,
    });

    assert.equal(body.contract, "C2.IngressMessage");
    assert.match(body.id, UUID_PATTERN);
    assert.match(body.endpoint_id, UUID_PATTERN);
    assert.equal(body.id, body.message.message_id);
    assert.equal(body.idempotency_key, body.message.message_id);

    assert.deepEqual(body.message.content, { type: "text", text: "Здравствуйте, где мой заказ?" });
    assert.equal(body.message.channel_type, "email");
    assert.equal(body.message.direction, "inbound");
    assert.equal(body.message.sender_ref, "client@example.com");
    assert.equal(body.message.conversation_ref, "thread-42");
    assert.equal(body.message.external_message_id, "<abc@mail.example.com>");
    assert.deepEqual(body.message.identity, { type: "verified_email", value: "client@example.com" });
    assert.equal(body.message.occurred_at, "2026-07-11T09:59:00.000Z");
  });

  it("derives a stable message id from the Message-ID header (idempotency)", () => {
    const build = () =>
      buildEmailIngress({
        email: { message_id: "<abc@mail>", from: "a@b.com", text: "hi" },
        organizationId: "org-1",
        channelId: "chan-1",
        now,
      });

    assert.equal(build().id, build().id);
    // Иной канал → иной message_id (нет коллизии между каналами).
    const other = buildEmailIngress({
      email: { message_id: "<abc@mail>", from: "a@b.com", text: "hi" },
      organizationId: "org-1",
      channelId: "chan-2",
      now,
    });
    assert.notEqual(build().id, other.id);
  });

  it("falls back to the subject when the email has no body", () => {
    const body = buildEmailIngress({
      email: { message_id: "<x@mail>", from: "a@b.com", subject: "Только тема" },
      organizationId: "org-1",
      channelId: "chan-1",
      now,
    });
    assert.equal(body.message.content.text, "Только тема");
  });

  it("normalizes an attachment-only email", () => {
    const body = buildEmailIngress({
      email: {
        message_id: "<y@mail>",
        from: "a@b.com",
        attachments: [{ filename: "invoice.pdf", mime: "application/pdf", size: 2048 }],
      },
      organizationId: "org-1",
      channelId: "chan-1",
      now,
    });

    assert.equal(body.message.content.type, "file");
    assert.equal(body.message.content.text, undefined);
    assert.deepEqual(body.message.attachments[0], {
      id: "invoice.pdf",
      kind: "file",
      storage_ref: "email-attachment://invoice.pdf",
      mime: "application/pdf",
      filename: "invoice.pdf",
      size: 2048,
    });
  });

  it("infers image attachment kind from the MIME type", () => {
    const body = buildEmailIngress({
      email: {
        message_id: "<z@mail>",
        from: "a@b.com",
        text: "фото",
        attachments: [{ id: "img1", mime: "image/png" }],
      },
      organizationId: "org-1",
      channelId: "chan-1",
      now,
    });
    assert.equal(body.message.attachments[0].kind, "image");
  });

  it("rejects an email with neither text nor attachments", () => {
    assert.throws(
      () =>
        buildEmailIngress({
          email: { message_id: "<empty@mail>", from: "a@b.com" },
          organizationId: "org-1",
          channelId: "chan-1",
          now,
        }),
      NonIngestibleEmailError,
    );
  });

  it("rejects an email without a sender", () => {
    assert.throws(
      () => buildEmailIngress({ email: { text: "hi" }, organizationId: "org-1", channelId: "chan-1", now }),
      NonIngestibleEmailError,
    );
  });
});
