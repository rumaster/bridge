import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { PgDatabase } from "../../src/common/database/database.service";

const ORG_ID = "30000000-0000-4000-8000-000000000101";
const ADMIN_ID = "30000000-0000-4000-8000-000000000201";
const ADMIN_TOKEN = "brs_channels_admin";
const TELEGRAM_TOKEN = "123456789:AA-real-telegram-bot-token-value";
const MAX_TOKEN = "max-real-bot-access-token-abcdef0123456789";
const SECRET_KEY_HEX = "33".repeat(32);
const EMAIL_CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
  smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
  from_email: "support@example.com",
  from_name: "Служба поддержки",
};

describe("C3.channels M2 omnichannel API", () => {
  let app: INestApplication;
  let previousKey: string | undefined;
  let previousFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    previousKey = process.env.CHANNEL_SECRET_ENCRYPTION_KEY;
    process.env.CHANNEL_SECRET_ENCRYPTION_KEY = SECRET_KEY_HEX;
    previousFetch = globalThis.fetch;
    // getMe заглушка: реальный Telegram Bot API не вызывается в тесте.
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/getMe")) {
        return telegramResponse({ ok: true, result: { username: "bridge_support_bot", id: 42 } });
      }
      // MAX Bot API GET /me заглушка (Этап M1): реальный MAX Bot API не вызывается.
      if (url.includes("/me")) {
        return maxResponse({ user_id: 7001, name: "MAX Support Bot", username: "max_support_bot" });
      }
      return telegramResponse({ ok: false, description: "unexpected call" }, 404);
    }) as unknown as typeof globalThis.fetch;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PgDatabase)
      .useValue(createChannelsDatabaseStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.CHANNEL_SECRET_ENCRYPTION_KEY;
    } else {
      process.env.CHANNEL_SECRET_ENCRYPTION_KEY = previousKey;
    }
  });

  it("connects Web Chat and returns its C6 capabilities", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "web_chat",
        name: "Основной Web Chat",
        credentials_ref: "secret://web-chat/tenant-a/main",
        config: { widget_origin: "https://example.test" },
      })
      .expect(201);

    expect(createResponse.body.channel).toMatchObject({
      organization_id: ORG_ID,
      channel_type: "web_chat",
      name: "Основной Web Chat",
      status: "connected",
      credentials_ref: "secret://web-chat/tenant-a/main",
    });
    expect(createResponse.body.channel).not.toHaveProperty("token");

    const channelId = createResponse.body.channel.id;

    await request(app.getHttpServer())
      .get("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((channel: { id: string }) => channel.id)).toContain(channelId);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}/capabilities`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C6.CapabilityDescriptor");
        expect(body.channel_type).toBe("web_chat");
        expect(body.channel_id).toBe(channelId);
        expect(body.capabilities.text.supported).toBe(true);
        expect(body.capabilities.read_receipt.supported).toBe(true);
        expect(body.capabilities.buttons.supported).toBe(false);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}:test`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.accepted).toBe(true);
        expect(body.channel_id).toBe(channelId);
        expect(body.status).toBe("connected");
      });
  });

  it("connects Telegram with a bot token, stores only credentials_ref, and validates via getMe", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "telegram",
        name: "Telegram Support",
        credentials: TELEGRAM_TOKEN,
        config: {},
      })
      .expect(201);

    const channel = createResponse.body.channel;
    // Токен не возвращается; сервер сгенерировал credentials_ref.
    expect(channel).not.toHaveProperty("token");
    expect(channel).not.toHaveProperty("credentials");
    expect(channel.credentials_ref).toEqual(expect.stringContaining(`secret://telegram/${ORG_ID}/`));
    expect(channel.status).toBe("connected");

    const channelId = channel.id;

    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}:test`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.accepted).toBe(true);
        expect(body.status).toBe("connected");
      });

    await request(app.getHttpServer())
      .get("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        const stored = body.find((item: { id: string }) => item.id === channelId);
        expect(stored.config).toMatchObject({ bot_username: "bridge_support_bot", bot_id: 42 });
        expect(stored).not.toHaveProperty("credentials_envelope");
      });
  });

  it("connects MAX with a bot token, stores only credentials_ref, and validates via /me (M1)", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "max",
        name: "MAX Support",
        credentials: MAX_TOKEN,
        config: {},
      })
      .expect(201);

    const channel = createResponse.body.channel;
    // Токен не возвращается; сервер сгенерировал credentials_ref secret://max/...
    expect(channel).not.toHaveProperty("token");
    expect(channel).not.toHaveProperty("credentials");
    expect(channel.credentials_ref).toEqual(expect.stringContaining(`secret://max/${ORG_ID}/`));
    expect(channel.status).toBe("connected");

    const channelId = channel.id;

    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}/capabilities`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        expect(body.channel_type).toBe("max");
        expect(body.capabilities.text.supported).toBe(true);
        expect(body.capabilities.typing_indicator.supported).toBe(true);
        expect(body.capabilities.read_receipt.supported).toBe(false);
      });

    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}:test`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.accepted).toBe(true);
        expect(body.status).toBe("connected");
      });

    await request(app.getHttpServer())
      .get("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        const stored = body.find((item: { id: string }) => item.id === channelId);
        expect(stored.config).toMatchObject({ bot_username: "max_support_bot", bot_id: 7001 });
        expect(stored).not.toHaveProperty("credentials_envelope");
      });
  });

  it("marks a MAX channel as error when :test has no stored token (M1)", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "max",
        name: "MAX Refless",
        credentials_ref: "secret://max/tenant-a/external",
        config: {},
      })
      .expect(201);

    const channelId = createResponse.body.channel.id;

    await request(app.getHttpServer())
      .post(`/api/v1/channels/${channelId}:test`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe("error");
        expect(body.error).toContain("Токен");
      });
  });

  it("resolves the org's Telegram delivery token over the internal S2S endpoint (T2)", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "telegram",
        name: "Telegram Delivery Bot",
        credentials: TELEGRAM_TOKEN,
      })
      .expect(201);

    // SVC-INT (без сессии, S2S) получает расшифрованный токen по org + channel_type.
    await request(app.getHttpServer())
      .get(`/internal/channels/secret?organization_id=${ORG_ID}&channel_type=telegram`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.token).toBe(TELEGRAM_TOKEN);
      });

    // Нет канала такого типа → 404 (SVC-INT зафиксирует доставку как failed).
    await request(app.getHttpServer())
      .get(`/internal/channels/secret?organization_id=${ORG_ID}&channel_type=vk`)
      .expect(404);
  });

  it("lists active telegram channels over the internal S2S endpoint without tokens (T3)", async () => {
    // SVC-INT (без сессии, S2S) получает реестр подключённых telegram-каналов,
    // чтобы поднять входящий поллер и смаппить апдейт бота → организацию. Токен в
    // ответе не публикуется — драйвер берёт его отдельным secret-эндпоинтом (T2).
    await request(app.getHttpServer())
      .get("/internal/channels?channel_type=telegram")
      .expect(200)
      .expect(({ body }) => {
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThan(0);
        for (const channel of body) {
          expect(channel.organization_id).toBe(ORG_ID);
          expect(typeof channel.channel_id).toBe("string");
          expect(typeof channel.config).toBe("object");
          expect(channel).not.toHaveProperty("token");
          expect(channel).not.toHaveProperty("credentials");
          expect(channel).not.toHaveProperty("credentials_ref");
          expect(channel).not.toHaveProperty("credentials_envelope");
        }
      });

    // Тип без подключённых каналов / неизвестный тип → пустой список (не ошибка).
    await request(app.getHttpServer())
      .get("/internal/channels?channel_type=sms")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual([]);
      });

    await request(app.getHttpServer())
      .get("/internal/channels?channel_type=bogus")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual([]);
      });
  });

  it.each([
    ["email", "secret://email/tenant-a/support", false, false],
    ["sms", "secret://sms/tenant-a/main", false, false],
    ["vk", "secret://vk/tenant-a/main", true, false],
    ["whatsapp", "secret://whatsapp/tenant-a/main", false, true],
  ] as const)(
    "connects %s, keeps only credentials_ref, tests connection, and returns C6",
    async (channelType, credentialsRef, typingIndicator, readReceipt) => {
      const createResponse = await request(app.getHttpServer())
        .post("/api/v1/channels")
        .set("authorization", `Bearer ${ADMIN_TOKEN}`)
        .set("x-organization-id", ORG_ID)
        .send({
          organization_id: ORG_ID,
          channel_type: channelType,
          name: `${channelType} основной`,
          credentials_ref: credentialsRef,
          config: { endpoint: `${channelType}-endpoint` },
        })
        .expect(201);

      expect(createResponse.body.channel).toMatchObject({
        organization_id: ORG_ID,
        channel_type: channelType,
        status: "connected",
        credentials_ref: credentialsRef,
      });
      expect(createResponse.body.channel).not.toHaveProperty("token");

      const channelId = createResponse.body.channel.id;

      await request(app.getHttpServer())
        .get(`/api/v1/channels/${channelId}/capabilities`)
        .set("authorization", `Bearer ${ADMIN_TOKEN}`)
        .set("x-organization-id", ORG_ID)
        .expect(200)
        .expect(({ body }) => {
          expect(body.channel_type).toBe(channelType);
          expect(body.channel_id).toBe(channelId);
          expect(body.capabilities.text.supported).toBe(true);
          expect(body.capabilities.typing_indicator.supported).toBe(typingIndicator);
          expect(body.capabilities.read_receipt.supported).toBe(readReceipt);
        });

      await request(app.getHttpServer())
        .post(`/api/v1/channels/${channelId}:test`)
        .set("authorization", `Bearer ${ADMIN_TOKEN}`)
        .set("x-organization-id", ORG_ID)
        .send({})
        .expect(200)
        .expect(({ body }) => {
          expect(body.accepted).toBe(true);
          expect(body.channel_id).toBe(channelId);
          expect(body.status).toBe("connected");
        });
    },
  );

  it("connects email with structured IMAP/SMTP credentials, storing them as one encrypted secret (E0)", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "email",
        name: "Email Support",
        email_credentials: EMAIL_CREDENTIALS,
        config: {},
      })
      .expect(201);

    const channel = createResponse.body.channel;
    // Секрет не возвращается ни в каком виде; сервер сгенерировал credentials_ref.
    expect(channel).not.toHaveProperty("email_credentials");
    expect(channel).not.toHaveProperty("credentials");
    expect(channel).not.toHaveProperty("credentials_envelope");
    expect(channel.credentials_ref).toEqual(expect.stringContaining(`secret://email/${ORG_ID}/`));

    // S2S-резолв возвращает расшифрованный структурный секрет (round-trip хранилища).
    const secret = await request(app.getHttpServer())
      .get(`/internal/channels/secret?organization_id=${ORG_ID}&channel_type=email`)
      .expect(200);
    const stored = JSON.parse(secret.body.token);
    expect(stored).toMatchObject({
      kind: "email_channel_credentials",
      imap: { host: "imap.example.com", port: 993, tls: true },
      smtp: { host: "smtp.example.com", port: 587 },
      from_email: "support@example.com",
    });
    expect(stored.imap.password).toBe("imap-secret");
  });

  it("rejects email_credentials for a non-email channel type (E0)", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "telegram",
        name: "Wrong Email Creds",
        email_credentials: EMAIL_CREDENTIALS,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("CHANNEL_CREDENTIALS_MISMATCH");
      });
  });

  it("updates name/config via PUT without touching the stored secret (E0)", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "telegram",
        name: "Telegram Before",
        credentials: TELEGRAM_TOKEN,
      })
      .expect(201);
    const channelId = created.body.channel.id;

    await request(app.getHttpServer())
      .put(`/api/v1/channels/${channelId}`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({ name: "Telegram After", config: { note: "renamed" } })
      .expect(200)
      .expect(({ body }) => {
        expect(body.channel.name).toBe("Telegram After");
        expect(body.channel.config).toMatchObject({ note: "renamed" });
        expect(body.channel.credentials_ref).toBe(created.body.channel.credentials_ref);
        expect(body.channel).not.toHaveProperty("credentials");
      });

    // Токен не тронут ротацией.
    await request(app.getHttpServer())
      .get(`/internal/channels/secret?organization_id=${ORG_ID}&channel_type=telegram`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.token).toBe(TELEGRAM_TOKEN);
      });
  });

  it("rotates email credentials via PUT (E0)", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/channels")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        organization_id: ORG_ID,
        channel_type: "email",
        name: "Email Rotate",
        email_credentials: EMAIL_CREDENTIALS,
      })
      .expect(201);
    const channelId = created.body.channel.id;

    await request(app.getHttpServer())
      .put(`/api/v1/channels/${channelId}`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({
        email_credentials: {
          ...EMAIL_CREDENTIALS,
          smtp: { ...EMAIL_CREDENTIALS.smtp, password: "rotated-smtp-secret" },
        },
      })
      .expect(200);

    const secret = await request(app.getHttpServer())
      .get(`/internal/channels/secret?organization_id=${ORG_ID}&channel_type=email`)
      .expect(200);
    expect(JSON.parse(secret.body.token).smtp.password).toBe("rotated-smtp-secret");
  });

  it("returns 404 when updating a channel that does not exist (E0)", async () => {
    await request(app.getHttpServer())
      .put("/api/v1/channels/30000000-0000-4000-8000-0000000009ff")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .send({ name: "Ghost" })
      .expect(404)
      .expect(({ body }) => {
        expect(body.code).toBe("CHANNEL_NOT_FOUND");
      });
  });
});

function telegramResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

function maxResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

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

/**
 * Комбинированный стаб PgDatabase: auth_sessions (одна сессия администратора) +
 * in-memory таблица channels (INSERT/SELECT/UPDATE + резолв credentials_envelope
 * для ChannelSecretService). Реальный Postgres не требуется.
 */
function createChannelsDatabaseStub(): Pick<PgDatabase, "withTenant"> {
  const channels = new Map<string, StoredChannelRow>();

  return {
    async withTenant(_organizationId, callback) {
      return callback({
        async query(text: string, values: readonly unknown[] = []) {
          return runSql(channels, text, values);
        },
      } as never);
    },
  };
}

function runSql(channels: Map<string, StoredChannelRow>, text: string, values: readonly unknown[]) {
  if (text.includes("FROM auth_sessions")) {
    return { rowCount: 1, rows: [adminSessionRow()] };
  }

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
    channels.set(id, row);
    return { rowCount: 1, rows: [selectProjection(row)] };
  }

  // updateChannel (PUT /v1/channels/:id): SET name = ..., RETURNING projection.
  if (text.includes("UPDATE channels") && text.includes("SET name")) {
    const [id, org] = values as [string, string];
    const row = channels.get(id);
    if (!row || row.organization_id !== org) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("credentials_envelope")) {
      const [, , name, config, ref, envelope, ts] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      row.name = name;
      row.config = JSON.parse(config);
      row.credentials_ref = ref;
      row.credentials_envelope = envelope ? JSON.parse(envelope) : null;
      row.updated_at = ts;
    } else {
      const [, , name, config, ts] = values as [string, string, string, string, string];
      row.name = name;
      row.config = JSON.parse(config);
      row.updated_at = ts;
    }
    return { rowCount: 1, rows: [selectProjection(row)] };
  }

  if (text.includes("UPDATE channels")) {
    const [id, org, status, checkedAt, config] = values as [string, string, string, string, string];
    const row = channels.get(id);
    if (!row || row.organization_id !== org) {
      return { rowCount: 0, rows: [] };
    }
    row.status = status;
    row.last_check_at = checkedAt;
    row.config = JSON.parse(config);
    row.updated_at = checkedAt;
    return { rowCount: 1, rows: [] };
  }

  // ChannelSecretService.resolveChannelSecret: SELECT credentials_envelope ... WHERE credentials_ref = $1
  if (text.includes("credentials_envelope") && text.includes("FROM channels")) {
    const [credentialsRef] = values as [string];
    for (const row of channels.values()) {
      if (row.credentials_ref === credentialsRef) {
        return { rowCount: 1, rows: [{ credentials_envelope: row.credentials_envelope }] };
      }
    }
    return { rowCount: 0, rows: [] };
  }

  if (text.includes("FROM channels") && text.includes("WHERE id =")) {
    const [id, org] = values as [string, string];
    const row = channels.get(id);
    if (!row || row.organization_id !== org) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [selectProjection(row)] };
  }

  // IntegrationGatewayFacade.listActiveChannelsByType (T3): cross-tenant list by
  // channel_type + status='connected', without the token.
  if (
    text.includes("FROM channels") &&
    text.includes("channel_type = $1") &&
    text.includes("status = 'connected'")
  ) {
    const [channelType] = values as [string];
    const list = [...channels.values()]
      .filter(
        (row) =>
          row.channel_type === channelType &&
          row.status === "connected" &&
          Boolean(row.credentials_ref),
      )
      .map((row) => ({ id: row.id, organization_id: row.organization_id, config: row.config }));
    return { rowCount: list.length, rows: list };
  }

  // IntegrationGatewayFacade.resolveChannelDeliveryToken: WHERE organization_id AND channel_type
  if (text.includes("FROM channels") && text.includes("channel_type = $2")) {
    const [org, channelType] = values as [string, string];
    const matches = [...channels.values()].filter(
      (row) =>
        row.organization_id === org &&
        row.channel_type === channelType &&
        row.status !== "disabled" &&
        row.credentials_ref,
    );
    const row = matches[matches.length - 1];
    return row
      ? { rowCount: 1, rows: [{ credentials_ref: row.credentials_ref }] }
      : { rowCount: 0, rows: [] };
  }

  if (text.includes("FROM channels")) {
    const [org] = values as [string];
    const list = [...channels.values()]
      .filter((row) => row.organization_id === org)
      .map(selectProjection);
    return { rowCount: list.length, rows: list };
  }

  throw new Error(`Unexpected SQL in channels stub: ${text}`);
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

function adminSessionRow() {
  return {
    display_name: "Channels Admin",
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    id: "30000000-0000-4000-8000-000000000901",
    issued_at: new Date("2026-07-03T10:00:00.000Z"),
    organization_id: ORG_ID,
    organization_name: "Tenant Channels",
    organization_status: "active",
    revoked_at: null,
    role_bindings: [{ role: "administrator", organizationId: ORG_ID }],
    roles: ["administrator"],
    telegram_username: "channels_admin",
    user_id: ADMIN_ID,
    user_status: "active",
  };
}
