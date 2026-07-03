import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";

describe("C3.channels Web Chat skeleton", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
      .send({
        organization_id: "org-1",
        channel_type: "web_chat",
        name: "Основной Web Chat",
        credentials_ref: "secret://web-chat/org-1/main",
        config: {
          widget_origin: "https://example.test",
        },
      })
      .expect(201);

    expect(createResponse.body.channel).toMatchObject({
      organization_id: "org-1",
      channel_type: "web_chat",
      name: "Основной Web Chat",
      status: "connected",
      credentials_ref: "secret://web-chat/org-1/main",
    });
    expect(createResponse.body.channel).not.toHaveProperty("token");

    const channelId = createResponse.body.channel.id;

    await request(app.getHttpServer())
      .get(`/api/v1/channels/${channelId}/capabilities`)
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
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.accepted).toBe(true);
        expect(body.channel_id).toBe(channelId);
        expect(body.status).toBe("connected");
      });
  });
});
