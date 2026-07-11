import {
  EMAIL_CHANNEL_CREDENTIALS_KIND,
  EmailChannelCredentialsFormatError,
  parseEmailChannelCredentials,
  serializeEmailChannelCredentials,
  type EmailChannelCredentials,
} from "../../src/common/secrets/email-channel-credentials";

const VALID: EmailChannelCredentials = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "  imap-pass  " },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-pass" },
  from_email: "support@example.com",
  from_name: "Служба поддержки",
};

describe("email channel credentials", () => {
  it("round-trips structured credentials through serialize/parse", () => {
    const parsed = parseEmailChannelCredentials(serializeEmailChannelCredentials(VALID));

    expect(parsed).toEqual(VALID);
  });

  it("preserves passwords verbatim (no trimming) but trims host/username", () => {
    const parsed = parseEmailChannelCredentials(
      serializeEmailChannelCredentials({
        ...VALID,
        imap: { ...VALID.imap, host: "  imap.example.com  ", username: " support@example.com " },
      }),
    );

    expect(parsed.imap.password).toBe("  imap-pass  ");
    expect(parsed.imap.host).toBe("imap.example.com");
    expect(parsed.imap.username).toBe("support@example.com");
  });

  it("tags the serialized secret with a discriminating kind", () => {
    const serialized = JSON.parse(serializeEmailChannelCredentials(VALID));

    expect(serialized.kind).toBe(EMAIL_CHANNEL_CREDENTIALS_KIND);
    expect(serialized.version).toBe(1);
  });

  it("omits from_name when blank", () => {
    const parsed = parseEmailChannelCredentials(
      serializeEmailChannelCredentials({ ...VALID, from_name: "   " }),
    );

    expect(parsed).not.toHaveProperty("from_name");
  });

  it("rejects a non-email secret (e.g. a Telegram bot token)", () => {
    expect(() => parseEmailChannelCredentials("123456789:AA-bot-token")).toThrow(
      EmailChannelCredentialsFormatError,
    );
  });

  it("rejects email-shaped JSON without the discriminating kind", () => {
    expect(() => parseEmailChannelCredentials(JSON.stringify({ imap: VALID.imap, smtp: VALID.smtp }))).toThrow(
      EmailChannelCredentialsFormatError,
    );
  });

  it.each([
    ["out-of-range port", { ...VALID, imap: { ...VALID.imap, port: 70000 } }],
    ["non-integer port", { ...VALID, smtp: { ...VALID.smtp, port: 5.5 } }],
    ["missing host", { ...VALID, imap: { ...VALID.imap, host: "" } }],
    ["missing password", { ...VALID, smtp: { ...VALID.smtp, password: "" } }],
  ])("rejects invalid credentials: %s", (_label, invalid) => {
    expect(() => serializeEmailChannelCredentials(invalid as EmailChannelCredentials)).toThrow(
      EmailChannelCredentialsFormatError,
    );
  });
});
