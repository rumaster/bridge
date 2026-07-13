import { ForbiddenException, HttpException, HttpStatus } from "@nestjs/common";

import { WebChatService } from "../../src/modules/web-chat/web-chat.service";
import { WebChatRateLimiter } from "../../src/modules/web-chat/web-chat-rate-limiter";

/**
 * Guard-логика createOrResumeSession (W4, WG-10/WG-11): включённость канала,
 * allow-list Origin, rate-limit. БД мокается — тест идёт без Docker.
 */

type QueryHandler = (sql: string) => { rowCount: number; rows: unknown[] } | null;

function fakeDatabase(handler: QueryHandler) {
  const client = {
    query: async (sql: string) => handler(sql) ?? { rowCount: 0, rows: [] },
  };
  return {
    withTenant: async (_org: string, cb: (c: typeof client) => Promise<unknown>) => cb(client),
  };
}

const realtime = { publishMessageCreated: async () => {} };

function service(handler: QueryHandler, limiter: Pick<WebChatRateLimiter, "tryConsume">) {
  return new WebChatService(
    fakeDatabase(handler) as never,
    realtime as never,
    limiter as never,
  );
}

const OK_LIMITER = { tryConsume: () => true };
const ORG = "22345678-1234-4234-8234-123456789abc";

describe("WebChatService createOrResumeSession guards (W4)", () => {
  it("429, если rate-limit исчерпан (до обращения к БД)", async () => {
    const svc = service(
      () => {
        throw new Error("DB must not be touched when rate-limited");
      },
      { tryConsume: () => false },
    );
    await expect(
      svc.createOrResumeSession({ organization_id: ORG }, { clientIp: "1.1.1.1" }),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it("403 WEB_CHAT_CHANNEL_DISABLED, если у организации нет connected web_chat", async () => {
    const svc = service(
      (sql) => (sql.includes("FROM channels") ? { rowCount: 0, rows: [] } : null),
      OK_LIMITER,
    );
    await expect(
      svc.createOrResumeSession({ organization_id: ORG }, {}),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "WEB_CHAT_CHANNEL_DISABLED" }),
    });
  });

  it("403 WEB_CHAT_ORIGIN_NOT_ALLOWED при чужом Origin", async () => {
    const svc = service(
      (sql) =>
        sql.includes("FROM channels")
          ? { rowCount: 1, rows: [{ config: { widget_origin: "https://shop.test" } }] }
          : null,
      OK_LIMITER,
    );
    await expect(
      svc.createOrResumeSession({ organization_id: ORG }, { origin: "https://evil.test" }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "WEB_CHAT_ORIGIN_NOT_ALLOWED" }),
    });
  });

  it("happy path: канал connected + разрешённый Origin → резюмирует сессию", async () => {
    const svc = service((sql) => {
      if (sql.includes("FROM channels")) {
        return { rowCount: 1, rows: [{ config: { widget_origin: "https://shop.test" } }] };
      }
      if (sql.includes("FROM communication_endpoints")) {
        return {
          rowCount: 1,
          rows: [
            {
              endpoint_id: "42345678-1234-4234-8234-123456789abc",
              client_id: "52345678-1234-4234-8234-123456789abc",
              verified: false,
              metadata: {},
              email: null,
              conversation_id: "32345678-1234-4234-8234-123456789abc",
            },
          ],
        };
      }
      return null;
    }, OK_LIMITER);

    const result = await svc.createOrResumeSession(
      { organization_id: ORG, visitor_session_id: "v-1" },
      { origin: "https://shop.test", clientIp: "1.1.1.1" },
    );
    expect(result).toMatchObject({
      organizationId: ORG,
      conversationId: "32345678-1234-4234-8234-123456789abc",
      endpointId: "42345678-1234-4234-8234-123456789abc",
    });
  });

  it("ForbiddenException/HttpException — корректные типы Nest", async () => {
    const disabled = service(
      (sql) => (sql.includes("FROM channels") ? { rowCount: 0, rows: [] } : null),
      OK_LIMITER,
    );
    await expect(
      disabled.createOrResumeSession({ organization_id: ORG }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const limited = service(() => null, { tryConsume: () => false });
    await expect(
      limited.createOrResumeSession({ organization_id: ORG }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
