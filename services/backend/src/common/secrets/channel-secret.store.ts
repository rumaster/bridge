import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

export interface ChannelSecretEnvelope {
  alg: "AES-256-GCM";
  kid: string;
  iv: string;
  tag: string;
  ciphertext: string;
  created_at: string;
}

export interface ChannelSecretCipherOptions {
  key: string;
  keyId?: string;
  now?: () => string;
  randomBytes?: (size: number) => Buffer;
}

export interface ChannelSecretDatabase {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount?: number | null; rows: T[] }>;
}

export class ChannelSecretCipher {
  private readonly key: Buffer;
  private readonly keyId: string;
  private readonly now: () => string;
  private readonly randomBytes: (size: number) => Buffer;

  constructor({
    key,
    keyId = "env:CHANNEL_SECRET_ENCRYPTION_KEY",
    now = () => new Date().toISOString(),
    randomBytes = nodeRandomBytes,
  }: ChannelSecretCipherOptions) {
    this.key = parseEnvelopeKey(key);
    this.keyId = keyId;
    this.now = now;
    this.randomBytes = randomBytes;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ChannelSecretCipher {
    const key = env.CHANNEL_SECRET_ENCRYPTION_KEY?.trim();
    if (!key) {
      throw new Error("CHANNEL_SECRET_ENCRYPTION_KEY is required for channel secrets");
    }

    return new ChannelSecretCipher({
      key,
      keyId: env.CHANNEL_SECRET_KEY_ID?.trim() || "env:CHANNEL_SECRET_ENCRYPTION_KEY",
    });
  }

  encrypt(plaintext: string): ChannelSecretEnvelope {
    const iv = this.randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return {
      alg: "AES-256-GCM",
      ciphertext: ciphertext.toString("base64"),
      created_at: this.now(),
      iv: iv.toString("base64"),
      kid: this.keyId,
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(envelope: ChannelSecretEnvelope): string {
    if (envelope.alg !== "AES-256-GCM") {
      throw new Error(`Unsupported channel secret envelope algorithm: ${envelope.alg}`);
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);

    return plaintext.toString("utf8");
  }
}

export class ChannelSecretStore {
  constructor(
    private readonly database: ChannelSecretDatabase,
    private readonly cipher = ChannelSecretCipher.fromEnv(),
  ) {}

  async putChannelSecret({
    channelId,
    organizationId,
    plaintext,
  }: {
    channelId: string;
    organizationId: string;
    plaintext: string;
  }): Promise<ChannelSecretEnvelope> {
    const envelope = this.cipher.encrypt(plaintext);
    const result = await this.database.query(
      `
        UPDATE channels
        SET credentials_envelope = $1::jsonb,
            updated_at = now()
        WHERE id = $2
          AND organization_id = $3
      `,
      [JSON.stringify(envelope), channelId, organizationId],
    );

    if (result.rowCount !== 1) {
      throw new Error("Channel was not found while storing credentials envelope");
    }

    return envelope;
  }

  async resolveChannelSecret({
    credentialsRef,
    organizationId,
  }: {
    credentialsRef: string;
    organizationId?: string;
  }): Promise<string | null> {
    const result = await this.database.query<{ credentials_envelope: ChannelSecretEnvelope | null }>(
      `
        SELECT credentials_envelope
        FROM channels
        WHERE credentials_ref = $1
          AND ($2::uuid IS NULL OR organization_id = $2::uuid)
        LIMIT 1
      `,
      [credentialsRef, organizationId ?? null],
    );
    const envelope = result.rows[0]?.credentials_envelope;
    return envelope ? this.cipher.decrypt(envelope) : null;
  }
}

function parseEnvelopeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : null;
  if (hex?.byteLength === 32) {
    return hex;
  }

  const base64 = Buffer.from(trimmed, "base64");
  if (base64.byteLength === 32) {
    return base64;
  }

  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.byteLength === 32) {
    return utf8;
  }

  throw new Error(
    "CHANNEL_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (hex, base64, or utf8)",
  );
}
