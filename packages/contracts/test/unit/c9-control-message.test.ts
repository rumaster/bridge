import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  C9_CONTROL_ACK_CONTRACT,
  C9_CONTROL_CONTRACT,
  C9_VERSION,
  createEdgeControlAck,
  createEdgeControlMessage,
  validateEdgeControlAck,
  validateEdgeControlMessage,
} from "../../src/c9.js";

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

describe("C9 App→Edge control message DTO", () => {
  it("builds and validates a channel_credentials_sync message", () => {
    const message = createEdgeControlMessage({
      type: "channel_credentials_sync",
      organizationId: "org-1",
      controlId: "ctl-creds-1",
      issuedAt: "2026-07-11T10:00:00.000Z",
      payload: { channel_id: "chan-1", channel_type: "email", credentials: EMAIL_CREDENTIALS },
    });

    assert.equal(message.contract, C9_CONTROL_CONTRACT);
    assert.equal(message.version, C9_VERSION);
    assert.equal(message.control_id, "ctl-creds-1");
    assert.equal(validateEdgeControlMessage(message).valid, true);
  });

  it("builds and validates an egress_dispatch message", () => {
    const message = createEdgeControlMessage({
      type: "egress_dispatch",
      organizationId: "org-1",
      controlId: "ctl-egress-1",
      issuedAt: "2026-07-11T10:00:00.000Z",
      payload: {
        message_id: "msg-1",
        channel_type: "email",
        recipient_ref: "client@example.com",
        subject: "Re: заявка",
        text: "Ответ менеджера",
      },
    });

    assert.equal(validateEdgeControlMessage(message).valid, true);
  });

  it("rejects an unknown control type", () => {
    const validation = validateEdgeControlMessage({
      ...createEdgeControlMessage({
        type: "channel_credentials_sync",
        organizationId: "org-1",
        controlId: "ctl-1",
        issuedAt: "2026-07-11T10:00:00.000Z",
        payload: { channel_type: "email", credentials: EMAIL_CREDENTIALS },
      }),
      type: "bogus",
    });

    assert.equal(validation.valid, false);
  });

  it("requires credentials for channel_credentials_sync", () => {
    const validation = validateEdgeControlMessage(
      createEdgeControlMessage({
        type: "channel_credentials_sync",
        organizationId: "org-1",
        controlId: "ctl-1",
        issuedAt: "2026-07-11T10:00:00.000Z",
        payload: { channel_type: "email" },
      }),
    );

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /payload\.credentials/);
  });

  it("requires message_id for egress_dispatch", () => {
    const validation = validateEdgeControlMessage(
      createEdgeControlMessage({
        type: "egress_dispatch",
        organizationId: "org-1",
        controlId: "ctl-1",
        issuedAt: "2026-07-11T10:00:00.000Z",
        payload: { channel_type: "email", recipient_ref: "client@example.com" },
      }),
    );

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /payload\.message_id/);
  });

  it("builds and validates a control ack", () => {
    const ack = createEdgeControlAck({
      controlId: "ctl-egress-1",
      accepted: true,
      status: "sent",
      externalMessageId: "smtp-42",
      receivedAt: "2026-07-11T10:00:01.000Z",
    });

    assert.equal(ack.contract, C9_CONTROL_ACK_CONTRACT);
    assert.equal(ack.duplicate, false);
    assert.equal(ack.external_message_id, "smtp-42");
    assert.equal(validateEdgeControlAck(ack).valid, true);
  });
});
