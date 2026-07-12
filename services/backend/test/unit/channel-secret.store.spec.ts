import {
  ChannelSecretCipher,
  ChannelSecretStore,
} from "../../src/common/secrets/channel-secret.store";

const KEY_HEX = "11".repeat(32);
const fixedNow = () => "2026-07-05T23:30:00.000Z";

describe("ChannelSecretStore", () => {
  it("encrypts channel credentials into an envelope without plaintext leakage", () => {
    const cipher = new ChannelSecretCipher({
      key: KEY_HEX,
      keyId: "test-key",
      now: fixedNow,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    const envelope = cipher.encrypt("telegram-bot-token");
    const serialized = JSON.stringify(envelope);

    expect(envelope).toMatchObject({
      alg: "AES-256-GCM",
      created_at: "2026-07-05T23:30:00.000Z",
      kid: "test-key",
    });
    expect(serialized).not.toContain("telegram-bot-token");
    expect(serialized).not.toContain("token");
    expect(cipher.decrypt(envelope)).toBe("telegram-bot-token");
  });

  it("encrypts a MAX bot token round-trip without plaintext leakage (M0)", () => {
    // Механизм канал-агностичен: секрет MAX (MVP — только токен бота) шифруется и
    // расшифровывается тем же envelope-шифром, что Telegram. Этап M0 плана
    // docs/plan/max-channel-production.md (закрывает MG-11).
    const cipher = new ChannelSecretCipher({
      key: KEY_HEX,
      keyId: "test-key",
      now: fixedNow,
      randomBytes: (size) => Buffer.alloc(size, 5),
    });

    const envelope = cipher.encrypt("max-bot-token");
    const serialized = JSON.stringify(envelope);

    expect(envelope).toMatchObject({
      alg: "AES-256-GCM",
      created_at: "2026-07-05T23:30:00.000Z",
      kid: "test-key",
    });
    expect(serialized).not.toContain("max-bot-token");
    expect(serialized).not.toContain("token");
    expect(cipher.decrypt(envelope)).toBe("max-bot-token");
  });

  it("resolves a MAX secret by credentials_ref from channels.credentials_envelope (M0)", async () => {
    const cipher = new ChannelSecretCipher({
      key: KEY_HEX,
      keyId: "test-key",
      now: fixedNow,
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const envelope = cipher.encrypt("max-bot-token");
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [{ credentials_envelope: envelope }],
      }),
    };
    const store = new ChannelSecretStore(database, cipher);

    await expect(
      store.resolveChannelSecret({
        credentialsRef: "secret://max/org-1/support",
        organizationId: "30000000-0000-4000-8000-000000000101",
      }),
    ).resolves.toBe("max-bot-token");
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM channels"),
      ["secret://max/org-1/support", "30000000-0000-4000-8000-000000000101"],
    );
  });

  it("resolves a secret by credentials_ref from channels.credentials_envelope", async () => {
    const cipher = new ChannelSecretCipher({
      key: KEY_HEX,
      keyId: "test-key",
      now: fixedNow,
      randomBytes: (size) => Buffer.alloc(size, 9),
    });
    const envelope = cipher.encrypt("email-provider-key");
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [{ credentials_envelope: envelope }],
      }),
    };
    const store = new ChannelSecretStore(database, cipher);

    await expect(
      store.resolveChannelSecret({
        credentialsRef: "secret://email/org-1/support",
        organizationId: "30000000-0000-4000-8000-000000000101",
      }),
    ).resolves.toBe("email-provider-key");
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM channels"),
      ["secret://email/org-1/support", "30000000-0000-4000-8000-000000000101"],
    );
  });
});
