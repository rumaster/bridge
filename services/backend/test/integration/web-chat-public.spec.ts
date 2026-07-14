import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { WebChatService } from "../../src/modules/web-chat/web-chat.service";

const ORGANIZATION_ID = "60000000-0000-4000-8000-000000000101";
const CONVERSATION_ID = "60000000-0000-4000-8000-000000000501";
const ENDPOINT_ID = "60000000-0000-4000-8000-000000000401";
const MESSAGE_ID = "60000000-0000-4000-8000-000000000601";
const VISITOR_SESSION_ID = "web-chat-visitor-public";

describe("Web Chat public API", () => {
  let app: INestApplication;
  const webChat = createWebChatServiceMock();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WebChatService)
      .useValue(webChat)
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("создаёт anonymous session без manager auth", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/web-chat/sessions")
      .send({
        organization_id: ORGANIZATION_ID,
        visitor_session_id: VISITOR_SESSION_ID,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          organizationId: ORGANIZATION_ID,
          visitorSessionId: VISITOR_SESSION_ID,
          conversationId: CONVERSATION_ID,
          endpointId: ENDPOINT_ID,
        });
      });
  });

  it("читает историю и отправляет сообщение через public web-chat paths", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/web-chat/conversations/${CONVERSATION_ID}/messages`)
      .query({
        organization_id: ORGANIZATION_ID,
        visitor_session_id: VISITOR_SESSION_ID,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toHaveLength(0);
      });

    await request(app.getHttpServer())
      .post("/api/v1/web-chat/messages")
      .send({
        organization_id: ORGANIZATION_ID,
        conversation_id: CONVERSATION_ID,
        endpoint_id: ENDPOINT_ID,
        idempotency_key: MESSAGE_ID,
        visitor_session_id: VISITOR_SESSION_ID,
        body: {
          type: "text",
          text: "Public message",
        },
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: MESSAGE_ID,
          organizationId: ORGANIZATION_ID,
          conversationId: CONVERSATION_ID,
          endpointId: ENDPOINT_ID,
          channel: "web_chat",
          direction: "inbound",
          senderType: "client",
        });
      });
  });

  it("принимает after_sequence_number=0 на догрузке истории (раньше @Min(1) → 400)", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/web-chat/conversations/${CONVERSATION_ID}/messages`)
      .query({
        organization_id: ORGANIZATION_ID,
        visitor_session_id: VISITOR_SESSION_ID,
        after_sequence_number: 0,
      })
      .expect(200);
  });

  it("поддерживает optional email/code auth для Web Chat visitor", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/web-chat/email-code")
      .send({
        organization_id: ORGANIZATION_ID,
        visitor_session_id: VISITOR_SESSION_ID,
        email: "client@example.com",
      })
      .expect(201);

    expect(start.body).toMatchObject({
      accepted: true,
      requestId: "60000000-0000-4000-8000-000000000701",
    });

    await request(app.getHttpServer())
      .post("/api/v1/web-chat/email-code:verify")
      .send({
        organization_id: ORGANIZATION_ID,
        visitor_session_id: VISITOR_SESSION_ID,
        email: "client@example.com",
        code: "123456",
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          organizationId: ORGANIZATION_ID,
          visitorSessionId: VISITOR_SESSION_ID,
          verifiedEmail: "client@example.com",
        });
      });
  });
});

function createWebChatServiceMock(): Pick<
  WebChatService,
  "createOrResumeSession" | "listMessages" | "sendMessage" | "startEmailCode" | "verifyEmailCode"
> {
  return {
    async createOrResumeSession() {
      return {
        organizationId: ORGANIZATION_ID,
        visitorSessionId: VISITOR_SESSION_ID,
        conversationId: CONVERSATION_ID,
        endpointId: ENDPOINT_ID,
      };
    },
    async listMessages() {
      return {
        items: [],
        page: { limit: 20, total: 0 },
      };
    },
    async sendMessage() {
      return {
        id: MESSAGE_ID,
        organizationId: ORGANIZATION_ID,
        conversationId: CONVERSATION_ID,
        endpointId: ENDPOINT_ID,
        channel: "web_chat",
        direction: "inbound",
        senderType: "client",
        sequenceNumber: 1,
        type: "text",
        content: { text: "Public message" },
        status: "received",
        createdAt: "2026-07-07T08:00:00.000Z",
        deliveredAt: null,
      };
    },
    async startEmailCode() {
      return {
        accepted: true,
        requestId: "60000000-0000-4000-8000-000000000701",
        expiresAt: "2026-07-07T08:05:00.000Z",
      };
    },
    async verifyEmailCode() {
      return {
        organizationId: ORGANIZATION_ID,
        visitorSessionId: VISITOR_SESSION_ID,
        conversationId: CONVERSATION_ID,
        endpointId: ENDPOINT_ID,
        verifiedEmail: "client@example.com",
      };
    },
  };
}
