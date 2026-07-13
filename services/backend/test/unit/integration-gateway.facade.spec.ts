import type { PoolClient } from "pg";

import {
  IntegrationGatewayFacade,
  type IntegrationGatewayFacadeOptions,
} from "../../src/modules/integration-gateway/integration-gateway.facade";

const fixedNow = () => "2026-07-03T09:00:00.000Z";
const ORG_ID = "org-1";
const TELEGRAM_TOKEN = "123456789:AA-real-telegram-bot-token-value";
const MAX_TOKEN = "max-real-bot-access-token-abcdef0123456789";
const EMAIL_CREDENTIALS = {
  imap: { host: "mailserver", port: 143, tls: false, username: "support@bridge.local", password: "imap-secret" },
  smtp: { host: "mailserver", port: 587, tls: false, username: "support@bridge.local", password: "smtp-secret" },
  from_email: "support@bridge.local",
};

function createFacade(overrides: Partial<IntegrationGatewayFacadeOptions> = {}) {
  return new IntegrationGatewayFacade({
    clock: fixedNow,
    database: createChannelsDb(),
    channelSecrets: createSecretStub(),
    ...overrides,
  });
}

describe("IntegrationGatewayFacade", () => {
  it("берёт C6 capabilities из upstream SVC-INT, а не из локального дескриптора", async () => {
    const upstream = {
      async getChannelCapabilities(channelId: string, organizationId?: string) {
        expect(channelId).toBe("telegram-live");
        expect(organizationId).toBe(ORG_ID);
        return {
          contract: "C6.CapabilityDescriptor",
          version: "1.0.0",
          channel_type: "telegram",
          channel_id: channelId,
          adapter: { name: "telegram-adapter", version: "0.0.0" },
          capabilities: {
            text: { supported: true },
            image: { supported: true },
            file: { supported: true },
            voice: { supported: true },
            video: { supported: true },
            buttons: { supported: true, constraints: { format: "inline_keyboard" } },
            reactions: { supported: false },
            typing_indicator: { supported: true },
            read_receipt: { supported: false },
            delete: { supported: true },
            edit: { supported: true },
          },
          generated_at: fixedNow(),
        };
      },
    };
    const facade = createFacade({ upstream });

    await expect(facade.getChannelCapabilities("telegram-live", ORG_ID)).resolves.toMatchObject({
      channel_id: "telegram-live",
      channel_type: "telegram",
      adapter: { name: "telegram-adapter" },
      capabilities: {
        buttons: { supported: true, constraints: { format: "inline_keyboard" } },
      },
    });
    expect(facade.getStatus()).toMatchObject({ mode: "http", status: "available" });
  });

  it("подключает Web Chat по credentials_ref и публикует C6 capabilities", async () => {
    const facade = createFacade();

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "web_chat",
      name: "Основной Web Chat",
      credentials_ref: "secret://web-chat/org-1/main",
      config: { widget_origin: "https://example.test" },
    });

    expect(channel).toMatchObject({
      organization_id: ORG_ID,
      channel_type: "web_chat",
      name: "Основной Web Chat",
      status: "connected",
      credentials_ref: "secret://web-chat/org-1/main",
      created_at: fixedNow(),
      updated_at: fixedNow(),
    });
    expect(channel).not.toHaveProperty("token");
    expect(channel).not.toHaveProperty("credentials");

    await expect(facade.listChannels(ORG_ID)).resolves.toEqual([channel]);

    const capabilities = await facade.getChannelCapabilities(channel.id, ORG_ID);
    expect(capabilities.channel_id).toBe(channel.id);
    expect(capabilities.capabilities.text.supported).toBe(true);
    expect(capabilities.capabilities.read_receipt.supported).toBe(true);
    expect(capabilities.capabilities.voice.supported).toBe(false);
  });

  it("шифрует токен Telegram-бота, генерирует credentials_ref и не возвращает секрет", async () => {
    const secrets = createSecretStub();
    const facade = createFacade({ channelSecrets: secrets });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "telegram",
      name: "Support Bot",
      credentials: TELEGRAM_TOKEN,
      config: {},
    });

    // Токен не возвращается; credentials_ref сгенерирован сервером.
    expect(channel).not.toHaveProperty("token");
    expect(channel).not.toHaveProperty("credentials");
    expect(channel.credentials_ref).toBe(`secret://telegram/${ORG_ID}/${channel.id}`);
    expect(channel.status).toBe("connected");
    expect(secrets.storedPlaintextFor(channel.credentials_ref!)).toBe(TELEGRAM_TOKEN);
  });

  it(":test для Telegram дёргает getMe, ставит connected и сохраняет bot_username", async () => {
    const fetchImpl = jest.fn(async () => telegramResponse({ ok: true, result: { username: "bridge_support_bot", id: 42 } }));
    const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "telegram",
      name: "Support Bot",
      credentials: TELEGRAM_TOKEN,
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/bot${TELEGRAM_TOKEN}/getMe`),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({ accepted: true, channel_id: channel.id, status: "connected" });
    expect(result.error).toBeUndefined();

    const [stored] = await facade.listChannels(ORG_ID);
    expect(stored.config).toMatchObject({ bot_username: "bridge_support_bot", bot_id: 42 });
    expect(stored.last_check_at).toBe(fixedNow());
  });

  it(":test для Telegram помечает канал error, если getMe отклонён", async () => {
    const fetchImpl = jest.fn(async () => telegramResponse({ ok: false, description: "Unauthorized" }, 401));
    const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "telegram",
      name: "Broken Bot",
      credentials: TELEGRAM_TOKEN,
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Unauthorized");
  });

  it(":test для Telegram без сохранённого токена помечает канал error", async () => {
    const facade = createFacade();

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "telegram",
      name: "Refless Bot",
      credentials_ref: "secret://telegram/org-1/external",
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Токен");
  });

  it("шифрует токен MAX-бота, генерирует credentials_ref и не возвращает секрет (M1)", async () => {
    const secrets = createSecretStub();
    const facade = createFacade({ channelSecrets: secrets });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "max",
      name: "MAX Support",
      credentials: MAX_TOKEN,
      config: {},
    });

    expect(channel).not.toHaveProperty("credentials");
    expect(channel.credentials_ref).toBe(`secret://max/${ORG_ID}/${channel.id}`);
    expect(channel.status).toBe("connected");
    expect(secrets.storedPlaintextFor(channel.credentials_ref!)).toBe(MAX_TOKEN);
  });

  it(":test для MAX дёргает /me, ставит connected и сохраняет bot_username (M1)", async () => {
    const fetchImpl = jest.fn(async () =>
      maxResponse({ user_id: 7001, name: "MAX Support Bot", username: "max_support_bot" }),
    );
    const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "max",
      name: "MAX Support",
      credentials: MAX_TOKEN,
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/me?access_token=${MAX_TOKEN}`),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({ accepted: true, channel_id: channel.id, status: "connected" });
    expect(result.error).toBeUndefined();

    const [stored] = await facade.listChannels(ORG_ID);
    expect(stored.config).toMatchObject({ bot_username: "max_support_bot", bot_id: 7001 });
  });

  it(":test для MAX помечает канал error, если /me отклонён (M1)", async () => {
    const fetchImpl = jest.fn(async () => maxResponse({ code: "unauthorized", message: "Invalid token" }, 401));
    const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "max",
      name: "Broken MAX",
      credentials: MAX_TOKEN,
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Invalid token");
  });

  it(":test для MAX без сохранённого токена помечает канал error (M1)", async () => {
    const facade = createFacade();

    const channel = await facade.connectChannel({
      organization_id: ORG_ID,
      channel_type: "max",
      name: "Refless MAX",
      credentials_ref: "secret://max/org-1/external",
    });

    const result = await facade.testChannel(channel.id, ORG_ID);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Токен");
  });

  it("публикует channel_credentials_sync на Edge при подключении email-канала (EDGE_CONTROL_URL)", async () => {
    const prev = process.env.EDGE_CONTROL_URL;
    process.env.EDGE_CONTROL_URL = "http://edge.test/internal/edge/control/messages";
    try {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
      const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

      const channel = await facade.connectChannel({
        organization_id: ORG_ID,
        channel_type: "email",
        name: "Bridge Mail",
        email_credentials: EMAIL_CREDENTIALS,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://edge.test/internal/edge/control/messages");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        contract: "C9.EdgeControlMessage",
        type: "channel_credentials_sync",
        organization_id: ORG_ID,
        control_id: `creds-${channel.id}-${fixedNow()}`,
        payload: {
          channel_id: channel.id,
          channel_type: "email",
          credentials: EMAIL_CREDENTIALS,
        },
      });
      // Валидатор control-plane требует credentials объектом, а не строкой.
      expect(typeof body.payload.credentials).toBe("object");
    } finally {
      if (prev === undefined) delete process.env.EDGE_CONTROL_URL;
      else process.env.EDGE_CONTROL_URL = prev;
    }
  });

  it("connect не падает, если Edge-control недоступен (best-effort)", async () => {
    const prev = process.env.EDGE_CONTROL_URL;
    process.env.EDGE_CONTROL_URL = "http://edge.test/internal/edge/control/messages";
    try {
      const fetchImpl = jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

      const channel = await facade.connectChannel({
        organization_id: ORG_ID,
        channel_type: "email",
        name: "Bridge Mail",
        email_credentials: EMAIL_CREDENTIALS,
      });

      expect(channel.status).toBe("connected");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.EDGE_CONTROL_URL;
      else process.env.EDGE_CONTROL_URL = prev;
    }
  });

  it("не публикует creds-sync без EDGE_CONTROL_URL", async () => {
    const prev = process.env.EDGE_CONTROL_URL;
    delete process.env.EDGE_CONTROL_URL;
    try {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
      const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

      await facade.connectChannel({
        organization_id: ORG_ID,
        channel_type: "email",
        name: "Bridge Mail",
        email_credentials: EMAIL_CREDENTIALS,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.EDGE_CONTROL_URL = prev;
    }
  });

  it("bulk-resync (Ш2) проталкивает креды всех connected email-каналов per-channel", async () => {
    const prev = process.env.EDGE_CONTROL_URL;
    process.env.EDGE_CONTROL_URL = "http://edge.test/internal/edge/control/messages";
    try {
      const serialized = JSON.stringify({ kind: "email_channel_credentials", version: 1, ...EMAIL_CREDENTIALS });
      const rows = [
        { id: "chan-a", organization_id: ORG_ID, credentials_ref: "secret://email/org-1/chan-a", config: {}, updated_at: "2026-07-03T09:00:00.000Z" },
        { id: "chan-b", organization_id: "org-2", credentials_ref: "secret://email/org-2/chan-b", config: { note: "b" }, updated_at: "2026-07-03T10:00:00.000Z" },
      ];
      const database = {
        async withTenant(_org: string, cb: (client: unknown) => unknown) {
          return cb({ async query() { return { rowCount: rows.length, rows }; } });
        },
      };
      const channelSecrets = {
        buildCredentialsRef: () => "ref",
        encrypt: () => ({}),
        async resolveChannelSecret() { return serialized; },
      };
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
      const facade = createFacade({
        database: database as never,
        channelSecrets: channelSecrets as never,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const res = await facade.resyncEmailChannelCredentials();

      expect(res).toEqual({ synced: 2, total: 2 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
      expect(bodies.map((b) => b.payload.channel_id).sort()).toEqual(["chan-a", "chan-b"]);
      const a = bodies.find((b) => b.payload.channel_id === "chan-a");
      expect(a.type).toBe("channel_credentials_sync");
      expect(a.control_id).toBe("creds-chan-a-2026-07-03T09:00:00.000Z"); // стабилен по updated_at
      expect(a.payload.credentials).toMatchObject({ imap: { host: "mailserver" }, from_email: "support@bridge.local" });
      expect(typeof a.payload.credentials).toBe("object");
    } finally {
      if (prev === undefined) delete process.env.EDGE_CONTROL_URL;
      else process.env.EDGE_CONTROL_URL = prev;
    }
  });

  it("resync — no-op без EDGE_CONTROL_URL", async () => {
    const prev = process.env.EDGE_CONTROL_URL;
    delete process.env.EDGE_CONTROL_URL;
    try {
      const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
      const facade = createFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const res = await facade.resyncEmailChannelCredentials();
      expect(res).toEqual({ synced: 0, total: 0 });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.EDGE_CONTROL_URL = prev;
    }
  });
});

function telegramResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function maxResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

// --- In-memory channels table emulation ------------------------------------

interface StoredChannelRow {
  id: string;
  organization_id: string;
  channel_type: string;
  name: string;
  status: string;
  credentials_ref: string | null;
  credentials_envelope: unknown;
  config: Record<string, unknown>;
  last_check_at: string | null;
  created_at: string;
  updated_at: string;
}

function createChannelsDb() {
  const rows = new Map<string, StoredChannelRow>();

  return {
    async withTenant<T>(_organizationId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = {
        async query(text: string, values: readonly unknown[] = []) {
          return runChannelsSql(rows, text, values);
        },
      } as unknown as PoolClient;

      return callback(client);
    },
  };
}

function runChannelsSql(rows: Map<string, StoredChannelRow>, text: string, values: readonly unknown[]) {
  if (text.includes("INSERT INTO channels")) {
    const [id, org, channelType, name, ref, envelope, config, ts] = values as [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string,
    ];
    const row: StoredChannelRow = {
      id,
      organization_id: org,
      channel_type: channelType,
      name,
      status: "connected",
      credentials_ref: ref,
      credentials_envelope: envelope ? JSON.parse(envelope) : null,
      config: JSON.parse(config),
      last_check_at: null,
      created_at: ts,
      updated_at: ts,
    };
    rows.set(id, row);
    return { rowCount: 1, rows: [selectProjection(row)] };
  }

  if (text.includes("UPDATE channels")) {
    const [id, org, status, checkedAt, config] = values as [string, string, string, string, string];
    const row = rows.get(id);
    if (!row || row.organization_id !== org) {
      return { rowCount: 0, rows: [] };
    }
    row.status = status;
    row.last_check_at = checkedAt;
    row.config = JSON.parse(config);
    row.updated_at = checkedAt;
    return { rowCount: 1, rows: [] };
  }

  if (text.includes("FROM channels") && text.includes("WHERE id =")) {
    const [id, org] = values as [string, string];
    const row = rows.get(id);
    if (!row || row.organization_id !== org) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [selectProjection(row)] };
  }

  if (text.includes("FROM channels")) {
    const [org] = values as [string];
    const list = [...rows.values()]
      .filter((row) => row.organization_id === org)
      .map(selectProjection);
    return { rowCount: list.length, rows: list };
  }

  throw new Error(`Unexpected channels SQL in stub: ${text}`);
}

function selectProjection(row: StoredChannelRow) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    channel_type: row.channel_type,
    name: row.name,
    status: row.status,
    credentials_ref: row.credentials_ref,
    config: row.config,
    last_check_at: row.last_check_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- Channel secret port stub ----------------------------------------------

function createSecretStub() {
  let pendingRef: string | null = null;
  const byRef = new Map<string, string>();

  return {
    buildCredentialsRef({
      channelType,
      organizationId,
      label = "main",
    }: {
      channelType: string;
      organizationId: string;
      label?: string;
    }) {
      pendingRef = `secret://${channelType}/${organizationId}/${label}`;
      return pendingRef;
    },
    encrypt(plaintext: string) {
      if (pendingRef) {
        byRef.set(pendingRef, plaintext);
        pendingRef = null;
      }
      return {
        alg: "AES-256-GCM" as const,
        kid: "test-key",
        iv: "aXY=",
        tag: "dGFn",
        ciphertext: Buffer.from(plaintext).toString("base64"),
        created_at: fixedNow(),
      };
    },
    async resolveChannelSecret({ credentialsRef }: { credentialsRef: string; organizationId?: string }) {
      return byRef.get(credentialsRef) ?? null;
    },
    storedPlaintextFor(ref: string) {
      return byRef.get(ref) ?? null;
    },
  };
}
