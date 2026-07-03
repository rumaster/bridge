import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { PgDatabase } from "../../src/common/database/database.service";

const ORG_ID = "30000000-0000-4000-8000-000000000101";
const ADMIN_ID = "30000000-0000-4000-8000-000000000201";
const ADMIN_TOKEN = "brs_channels_admin";

describe("C3.channels M2 omnichannel API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PgDatabase)
      .useValue(createAuthDatabaseStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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
        config: {
          widget_origin: "https://example.test",
        },
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
        expect(body.map((channel: { id: string }) => channel.id)).toEqual([channelId]);
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
        expect(body.capabilities.image.supported).toBe(true);
        expect(body.capabilities.file.supported).toBe(true);
        expect(body.capabilities.typing_indicator.supported).toBe(true);
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

  it.each([
    ["telegram", "secret://telegram/tenant-a/main", true, false],
    ["email", "secret://email/tenant-a/support", false, false],
    ["sms", "secret://sms/tenant-a/main", false, false],
    ["vk", "secret://vk/tenant-a/main", true, false],
    ["max", "secret://max/tenant-a/main", true, false],
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
          config: {
            endpoint: `${channelType}-endpoint`,
          },
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
          expect(body.contract).toBe("C6.CapabilityDescriptor");
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
});

function createAuthDatabaseStub(): Pick<PgDatabase, "withTenant"> {
  return {
    async withTenant(_organizationId, callback) {
      return callback({
        async query() {
          return {
            rowCount: 1,
            rows: [
              {
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
              },
            ],
          };
        },
      } as never);
    },
  };
}
