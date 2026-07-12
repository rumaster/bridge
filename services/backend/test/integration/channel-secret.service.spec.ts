import { Test } from "@nestjs/testing";
import type { PoolClient } from "pg";

import { DatabaseModule } from "../../src/common/database/database.module";
import { PgDatabase } from "../../src/common/database/database.service";
import { ChannelSecretService } from "../../src/common/secrets/channel-secret.service";
import { SecretsModule } from "../../src/common/secrets/secrets.module";

const KEY_HEX = "22".repeat(32);
const ORG_ID = "30000000-0000-4000-8000-000000000101";
const CHANNEL_ID = "40000000-0000-4000-8000-000000000201";
const CREDENTIALS_REF = `secret://telegram/${ORG_ID}/main`;
const BOT_TOKEN = "123456789:AA-real-telegram-bot-token-value-xyz";
const MAX_CHANNEL_ID = "40000000-0000-4000-8000-000000000202";
const MAX_CREDENTIALS_REF = `secret://max/${ORG_ID}/support`;
const MAX_BOT_TOKEN = "max-real-bot-token-value-abc";

describe("ChannelSecretService (DR-03, Этап T0)", () => {
  let previousKey: string | undefined;

  beforeAll(() => {
    previousKey = process.env.CHANNEL_SECRET_ENCRYPTION_KEY;
    process.env.CHANNEL_SECRET_ENCRYPTION_KEY = KEY_HEX;
  });

  afterAll(() => {
    if (previousKey === undefined) {
      delete process.env.CHANNEL_SECRET_ENCRYPTION_KEY;
    } else {
      process.env.CHANNEL_SECRET_ENCRYPTION_KEY = previousKey;
    }
  });

  async function createService(database: Pick<PgDatabase, "withTenant">) {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, SecretsModule],
    })
      .overrideProvider(PgDatabase)
      .useValue(database)
      .compile();

    return moduleRef.get(ChannelSecretService);
  }

  it("резолвится из DI и сообщает о настроенном ключе", async () => {
    const service = await createService(createChannelsDatabaseStub());

    expect(service).toBeInstanceOf(ChannelSecretService);
    expect(service.isConfigured()).toBe(true);
  });

  it("строит каноническую ссылку secret://<channel>/<org>/<label>", async () => {
    const service = await createService(createChannelsDatabaseStub());

    expect(
      service.buildCredentialsRef({ channelType: "telegram", organizationId: ORG_ID }),
    ).toBe(CREDENTIALS_REF);
    expect(
      service.buildCredentialsRef({
        channelType: "telegram",
        organizationId: ORG_ID,
        label: "  support  ",
      }),
    ).toBe(`secret://telegram/${ORG_ID}/support`);
    // MAX использует тот же канал-агностичный формат (Этап M0, MG-11).
    expect(
      service.buildCredentialsRef({
        channelType: "max",
        organizationId: ORG_ID,
        label: "support",
      }),
    ).toBe(MAX_CREDENTIALS_REF);
  });

  it("шифрует и разрешает секрет канала MAX тем же механизмом, что Telegram (M0)", async () => {
    const stub = createChannelsDatabaseStub();
    const service = await createService(stub);

    const envelope = await service.putChannelSecret({
      channelId: MAX_CHANNEL_ID,
      organizationId: ORG_ID,
      plaintext: MAX_BOT_TOKEN,
    });

    expect(envelope.alg).toBe("AES-256-GCM");
    const serialized = JSON.stringify(stub.rows.get(MAX_CHANNEL_ID)?.credentials_envelope);
    expect(serialized).not.toContain(MAX_BOT_TOKEN);
    expect(serialized).not.toContain("token");

    const resolved = await service.resolveChannelSecret({
      credentialsRef: MAX_CREDENTIALS_REF,
      organizationId: ORG_ID,
    });
    expect(resolved).toBe(MAX_BOT_TOKEN);

    // Доступ к channels шёл только как platform operator (RLS-эмуляция стаба).
    expect(stub.nonOperatorCalls).toBe(0);
  });

  it("шифрует и разрешает секрет канала через RLS-контекст platform operator", async () => {
    const stub = createChannelsDatabaseStub();
    const service = await createService(stub);

    const envelope = await service.putChannelSecret({
      channelId: CHANNEL_ID,
      organizationId: ORG_ID,
      plaintext: BOT_TOKEN,
    });

    // Секрет хранится только как AES-256-GCM envelope, без plaintext-полей.
    expect(envelope.alg).toBe("AES-256-GCM");
    const serialized = JSON.stringify(stub.rows.get(CHANNEL_ID)?.credentials_envelope);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain("token");

    const resolved = await service.resolveChannelSecret({
      credentialsRef: CREDENTIALS_REF,
      organizationId: ORG_ID,
    });
    expect(resolved).toBe(BOT_TOKEN);

    // Доступ к channels шёл только как platform operator (RLS-эмуляция стаба).
    expect(stub.operatorCalls).toBeGreaterThanOrEqual(2);
    expect(stub.nonOperatorCalls).toBe(0);
  });
});

interface ChannelRow {
  organization_id: string;
  credentials_ref: string;
  credentials_envelope: Record<string, unknown> | null;
}

/**
 * Эмулирует таблицу `channels` под FORCE RLS: доступ разрешён только в контексте
 * platform operator (как это делает {@link ChannelSecretService}); запрос без
 * operator-контекста отклоняется, повторяя поведение `channels_tenant_isolation`.
 */
function createChannelsDatabaseStub() {
  const rows = new Map<string, ChannelRow>([
    [
      CHANNEL_ID,
      { organization_id: ORG_ID, credentials_ref: CREDENTIALS_REF, credentials_envelope: null },
    ],
    [
      MAX_CHANNEL_ID,
      { organization_id: ORG_ID, credentials_ref: MAX_CREDENTIALS_REF, credentials_envelope: null },
    ],
  ]);
  const stub = {
    rows,
    operatorCalls: 0,
    nonOperatorCalls: 0,
    async withTenant<T>(
      _organizationId: string,
      callback: (client: PoolClient) => Promise<T>,
      options: { isPlatformOperator?: boolean } = {},
    ): Promise<T> {
      if (options.isPlatformOperator) {
        stub.operatorCalls += 1;
      } else {
        stub.nonOperatorCalls += 1;
        throw new Error("RLS: channels access denied without platform operator context");
      }

      const client = {
        async query(text: string, values?: readonly unknown[]) {
          return runSql(rows, text, values ?? []);
        },
      } as unknown as PoolClient;

      return callback(client);
    },
  };

  return stub;
}

function runSql(rows: Map<string, ChannelRow>, text: string, values: readonly unknown[]) {
  if (text.includes("UPDATE channels")) {
    const [envelope, channelId, organizationId] = values as [string, string, string];
    const row = rows.get(channelId);
    if (!row || row.organization_id !== organizationId) {
      return { rowCount: 0, rows: [] };
    }
    row.credentials_envelope = JSON.parse(envelope);
    return { rowCount: 1, rows: [] };
  }

  if (text.includes("FROM channels")) {
    const [credentialsRef, organizationId] = values as [string, string | null];
    for (const row of rows.values()) {
      const orgMatches = organizationId === null || row.organization_id === organizationId;
      if (row.credentials_ref === credentialsRef && orgMatches) {
        return { rowCount: 1, rows: [{ credentials_envelope: row.credentials_envelope }] };
      }
    }
    return { rowCount: 0, rows: [] };
  }

  throw new Error(`Unexpected SQL in ChannelSecretService stub: ${text}`);
}
