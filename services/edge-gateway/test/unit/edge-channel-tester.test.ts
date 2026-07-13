import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeEmailTester } from "../../src/edge-channel-tester.js";

const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
};

describe("edge channel tester (E1)", () => {
  it("returns ok when both IMAP LOGIN and SMTP verify succeed, passing resolved config", async () => {
    const imapConfigs: any[] = [];
    const smtpConfigs: any[] = [];
    const tester = createEdgeEmailTester({
      probeImap: async (config) => {
        imapConfigs.push(config);
      },
      probeSmtp: async ({ smtp }) => {
        smtpConfigs.push(smtp);
      },
    });

    const result = await tester.test({ credentials: EMAIL_CREDENTIALS, channelType: "email" });

    assert.equal(result.ok, true);
    assert.equal(result.imap.ok, true);
    assert.equal(result.smtp.ok, true);
    assert.equal(result.detail, undefined);
    // IMAP-эндпоинт разложен в конфиг клиента (secure из tls, auth из username/password).
    assert.deepEqual(imapConfigs[0], {
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "support@example.com", pass: "imap-secret" },
    });
    assert.deepEqual(smtpConfigs[0], EMAIL_CREDENTIALS.smtp);
  });

  it("reports error with IMAP reason when the LOGIN is rejected, still probes SMTP", async () => {
    let smtpProbed = false;
    const tester = createEdgeEmailTester({
      probeImap: async () => {
        throw new Error("Invalid credentials (Failure)");
      },
      probeSmtp: async () => {
        smtpProbed = true;
      },
    });

    const result = await tester.test({ credentials: EMAIL_CREDENTIALS, channelType: "email" });

    assert.equal(result.ok, false);
    assert.equal(result.imap.ok, false);
    assert.equal(result.smtp.ok, true);
    assert.equal(smtpProbed, true, "SMTP probe must run independently of the IMAP failure");
    assert.match(result.detail ?? "", /IMAP:.*Invalid credentials/);
  });

  it("reports error with SMTP reason when AUTH is rejected", async () => {
    const tester = createEdgeEmailTester({
      probeImap: async () => {},
      probeSmtp: async () => {
        throw new Error("535 5.7.8 Authentication failed");
      },
    });

    const result = await tester.test({ credentials: EMAIL_CREDENTIALS, channelType: "email" });

    assert.equal(result.ok, false);
    assert.equal(result.imap.ok, true);
    assert.equal(result.smtp.ok, false);
    assert.match(result.detail ?? "", /SMTP:.*535/);
  });

  it("fails fast per side when credentials are structurally missing", async () => {
    let imapProbed = false;
    let smtpProbed = false;
    const tester = createEdgeEmailTester({
      probeImap: async () => {
        imapProbed = true;
      },
      probeSmtp: async () => {
        smtpProbed = true;
      },
    });

    const result = await tester.test({ credentials: { from_email: "x@y.z" }, channelType: "email" });

    assert.equal(result.ok, false);
    assert.equal(result.imap.ok, false);
    assert.equal(result.smtp.ok, false);
    assert.equal(imapProbed, false, "no IMAP probe without imap credentials");
    assert.equal(smtpProbed, false, "no SMTP probe without smtp credentials");
    assert.match(result.detail ?? "", /IMAP:.*IMAP/);
    assert.match(result.detail ?? "", /SMTP:.*SMTP/);
  });

  it("rejects an unsupported channel type without probing", async () => {
    let probed = false;
    const tester = createEdgeEmailTester({
      probeImap: async () => {
        probed = true;
      },
      probeSmtp: async () => {
        probed = true;
      },
    });

    const result = await tester.test({ credentials: EMAIL_CREDENTIALS, channelType: "telegram" });

    assert.equal(result.ok, false);
    assert.equal(probed, false);
    assert.match(result.detail ?? "", /telegram/);
  });
});
