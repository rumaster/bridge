import { performance } from "node:perf_hooks";

import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import type { AuthSessionContext } from "../../src/common/auth/auth-context";
import { SessionAuthGuard } from "../../src/common/auth/session-auth.guard";
import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { CommunicationCoreProxyService } from "../../src/modules/communication-core/communication-core-proxy.service";
import type {
  ConversationListResponseDto,
  CreateMessageDto,
  MessageListResponseDto,
  MessageResponseDto,
} from "../../src/modules/communication-core/communication-core.dto";

jest.setTimeout(60_000);

const SAMPLE_COUNT = 20;
const ORG_ID = "50000000-0000-4000-8000-000000000101";
const USER_ID = "50000000-0000-4000-8000-000000000201";
const CLIENT_ID = "50000000-0000-4000-8000-000000000301";
const CONVERSATION_ID = "50000000-0000-4000-8000-000000000501";
const ENDPOINT_ID = "50000000-0000-4000-8000-000000000401";
const MESSAGE_ID = "50000000-0000-4000-8000-000000000601";

describe("SVC-API M5 NFR latency probes", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(new AllowSessionAuthGuard())
      .overrideProvider(CommunicationCoreProxyService)
      .useValue(createCoreProbe())
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps Backend API p95 latency within TZ §25.2 targets without external LLM time", async () => {
    const probes: ProbeResult[] = [];

    probes.push(
      await measureProbe("conversation_list", 1_000, () =>
        request(app.getHttpServer())
          .get("/api/v1/conversations?limit=20")
          .set(headers())
          .expect(status(200)),
      ),
    );
    probes.push(
      await measureProbe("message_history", 2_000, () =>
        request(app.getHttpServer())
          .get(`/api/v1/conversations/${CONVERSATION_ID}/messages?limit=20`)
          .set(headers())
          .expect(status(200)),
      ),
    );
    probes.push(
      await measureProbe("send_message", 1_000, (iteration) =>
        request(app.getHttpServer())
          .post("/api/v1/messages")
          .set(headers({ "idempotency-key": idempotencyKey(iteration) }))
          .send({
            content: { text: `NFR reply ${iteration}` },
            conversationId: CONVERSATION_ID,
            endpointId: ENDPOINT_ID,
          })
          .expect(status(201)),
      ),
    );
    probes.push(
      await measureProbe("ai_assistant_without_llm", 500, (iteration) =>
        request(app.getHttpServer())
          .post("/api/v1/ai/assistant:suggest")
          .set(headers({ "x-request-id": `req-nfr-ai-${iteration}` }))
          .send({ query: "Сформулируй короткий ответ клиенту" })
          .expect(status(201)),
      ),
    );

    for (const probe of probes) {
      expect(probe.p95Ms).toBeLessThanOrEqual(probe.targetMs);
    }
  });
});

async function measureProbe(
  name: string,
  targetMs: number,
  run: (iteration: number) => Promise<unknown>,
): Promise<ProbeResult> {
  const durations: number[] = [];

  for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
    const started = performance.now();
    await run(iteration);
    durations.push(performance.now() - started);
  }

  return {
    maxMs: round(Math.max(...durations)),
    name,
    p95Ms: round(percentile(durations, 0.95)),
    samples: SAMPLE_COUNT,
    targetMs,
  };
}

function percentile(values: number[], rank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1);

  return sorted[index];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer nfr-probe",
    "x-organization-id": ORG_ID,
    ...extra,
  };
}

function idempotencyKey(iteration: number): string {
  return `50000000-0000-4000-8000-${(700 + iteration).toString().padStart(12, "0")}`;
}

function status(expectedStatus: number): (response: request.Response) => void {
  return (response) => {
    if (response.status !== expectedStatus) {
      throw new Error(
        `expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }
  };
}

function createCoreProbe(): Pick<
  CommunicationCoreProxyService,
  "createMessage" | "listConversationMessages" | "listConversations"
> {
  return {
    async createMessage(
      organizationId: string,
      payload: CreateMessageDto,
    ): Promise<MessageResponseDto> {
      return {
        channel: "web_chat",
        content:
          typeof payload.content === "string" ? { text: payload.content } : payload.content,
        conversationId: payload.conversationId,
        createdAt: "2026-07-04T10:00:00.000Z",
        deliveredAt: null,
        direction: "outbound",
        endpointId: payload.endpointId ?? "00000000-0000-4000-8000-000000000401",
        id: payload.id ?? MESSAGE_ID,
        organizationId,
        senderType: "manager",
        sequenceNumber: payload.sequenceNumber ?? 2,
        status: "routed",
        type: payload.type ?? "text",
      };
    },

    async listConversationMessages(
      _organizationId: string,
      _conversationId: string,
      limit: number,
    ): Promise<MessageListResponseDto> {
      return {
        items: [
          {
            channel: "web_chat",
            content: { text: "Здравствуйте" },
            conversationId: CONVERSATION_ID,
            createdAt: "2026-07-04T10:00:00.000Z",
            deliveredAt: null,
            direction: "inbound",
            endpointId: ENDPOINT_ID,
            id: MESSAGE_ID,
            organizationId: ORG_ID,
            senderType: "client",
            sequenceNumber: 1,
            status: "received",
            type: "text",
          },
        ],
        page: { limit, total: 1 },
      };
    },

    async listConversations(
      _organizationId: string,
      limit: number,
    ): Promise<ConversationListResponseDto> {
      return {
        items: [
          {
            clientId: CLIENT_ID,
            createdAt: "2026-07-04T10:00:00.000Z",
            id: CONVERSATION_ID,
            lastMessageAt: "2026-07-04T10:00:00.000Z",
            organizationId: ORG_ID,
            status: "open",
            updatedAt: "2026-07-04T10:00:00.000Z",
          },
        ],
        page: { limit, total: 1 },
      };
    },
  };
}

class AllowSessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requestObject = context.switchToHttp().getRequest<{ auth?: AuthSessionContext }>();
    requestObject.auth = {
      authenticated: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      implementationStage: "M2",
      organization: {
        id: ORG_ID,
        name: "NFR Probe",
        slug: "nfr-probe",
        status: "active",
      },
      roleBindings: [
        { organizationId: ORG_ID, role: "administrator" },
        { organizationId: ORG_ID, role: "manager" },
      ],
      roles: ["administrator", "manager"],
      session: {
        expiresAt: "2099-01-01T00:00:00.000Z",
        id: "50000000-0000-4000-8000-000000000901",
        issuedAt: "2026-07-04T10:00:00.000Z",
        mode: "server",
        revokedAt: null,
      },
      token: "nfr-probe",
      user: {
        displayName: "NFR Probe Manager",
        id: USER_ID,
        organizationId: ORG_ID,
        role: "administrator",
        status: "active",
        telegramUsername: "nfr_probe",
      },
    };

    return true;
  }
}

interface ProbeResult {
  maxMs: number;
  name: string;
  p95Ms: number;
  samples: number;
  targetMs: number;
}
