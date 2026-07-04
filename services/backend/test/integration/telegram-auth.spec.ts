import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { TelegramCodeDeliveryService } from "../../src/modules/identity/telegram-bot.service";

jest.setTimeout(300_000);

const POSTGRES_PORT = 5432;
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const DB = {
  database: "bridge_telegram_auth_test",
  password: "bridge_telegram_auth_test",
  user: "bridge_telegram_auth_test",
};
const SEEDED_ADMIN_TELEGRAM = "seeded_admin";
const DEMO_ORG = "00000000-0000-4000-8000-000000000101";
const SEEDED_ADMIN_ID = "00000000-0000-4000-8000-000000000201";

describe("SVC-IDN Telegram authentication (login/telegram/start + verify)", () => {
  let app: INestApplication;
  let container: StartedTestContainer;
  let delivery: TelegramCodeDeliveryService;
  const previousBotToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeAll(async () => {
    // Force in-memory code retention (bot token unset) so the test can read the delivered code.
    delete process.env.TELEGRAM_BOT_TOKEN;

    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: DB.database,
        POSTGRES_PASSWORD: DB.password,
        POSTGRES_USER: DB.user,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const databaseUrl = connectionString(container);
    process.env.DATABASE_URL = databaseUrl;

    runRootScript("scripts/db-migrate.mjs", ["up"], databaseUrl);
    runRootScript("scripts/db-seed.mjs", [], databaseUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();

    delivery = app.get(TelegramCodeDeliveryService);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    delete process.env.DATABASE_URL;
    if (previousBotToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousBotToken;
    }
  });

  it("exposes the Telegram login routes instead of returning 404 (regression for issue #187)", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(202)
      .expect(({ body }) => {
        expect(body.code).not.toBe("NOT_FOUND");
        expect(body.status).toBe("code_delivery_scheduled");
        expect(body.delivery).toBe("telegram");
        expect(body.deliveryChannel).toBe("telegram");
        expect(body.telegramUsername).toBe(SEEDED_ADMIN_TELEGRAM);
        expect(typeof body.requestId).toBe("string");
        expect(body.expiresInSeconds).toBe(300);
        // No bot token configured in CI, so the code is generated but not delivered.
        expect(body.note).toBe("telegram_bot_not_configured");
      })
      .then((response) => response.body as { requestId: string });

    expect(typeof start.requestId).toBe("string");
  });

  it("verifies a code by requestId (manager-workspace contract) and issues a working session", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(202)
      .then((response) => response.body as { requestId: string });

    const retained = delivery.consumeDelivery(start.requestId);
    expect(retained).toBeDefined();
    const code = retained!.code;
    expect(code).toMatch(/^\d{6}$/);

    const session = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/verify")
      .send({ code, requestId: start.requestId })
      .expect(200)
      .expect(({ body }) => {
        expect(body.authenticated).toBe(true);
        expect(body.token).toMatch(/^brs_/);
        expect(body.user.id).toBe(SEEDED_ADMIN_ID);
        expect(body.user.telegramUsername).toBe(SEEDED_ADMIN_TELEGRAM);
        expect(body.user.role).toBe("administrator");
        expect(body.organization.id).toBe(DEMO_ORG);
        expect(body.roles).toEqual(expect.arrayContaining(["administrator"]));
      })
      .expect(({ headers }) => {
        expect(headers["set-cookie"]?.[0]).toContain("bridge_session=");
        expect(headers["set-cookie"]?.[0]).toContain("HttpOnly");
      })
      .then((response) => response.body as { token: string });

    // GET /auth/session returns the active session for the issued token.
    await request(app.getHttpServer())
      .get("/api/v1/auth/session")
      .set("authorization", `Bearer ${session.token}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.authenticated).toBe(true);
        expect(body.user.id).toBe(SEEDED_ADMIN_ID);
        expect(body.token).toBe(session.token);
      });

    // POST /auth/logout revokes the session.
    await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("authorization", `Bearer ${session.token}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.loggedOut).toBe(true);
      });

    // After logout the session is no longer valid.
    await request(app.getHttpServer())
      .get("/api/v1/auth/session")
      .set("authorization", `Bearer ${session.token}`)
      .expect(401);
  });

  it("verifies a code by telegramUsername (saas-admin contract)", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(202)
      .then((response) => response.body as { requestId: string });

    const retained = delivery.consumeDelivery(start.requestId);
    expect(retained).toBeDefined();

    await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/verify")
      .send({ code: retained!.code, telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(200)
      .expect(({ body }) => {
        expect(body.authenticated).toBe(true);
        expect(body.token).toMatch(/^brs_/);
        expect(body.user.telegramUsername).toBe(SEEDED_ADMIN_TELEGRAM);
      });
  });

  it("rejects an invalid code with 401 (not 404) and never issues a session", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(202)
      .then((response) => response.body as { requestId: string });

    // Discard the real code so it cannot be reused.
    delivery.consumeDelivery(start.requestId);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/verify")
      .send({ code: "000000", requestId: start.requestId })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("TELEGRAM_LOGIN_INVALID");
      });
  });

  it("persists failed attempts and locks the code after too many tries", async () => {
    const start = await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: SEEDED_ADMIN_TELEGRAM })
      .expect(202)
      .then((response) => response.body as { requestId: string });

    // Keep the real code so the wrong guesses below are genuinely wrong.
    const retained = delivery.consumeDelivery(start.requestId);
    expect(retained).toBeDefined();
    const wrongCode = retained!.code === "000000" ? "111111" : "000000";

    // The attempt counter must survive each rejected request (it is committed even
    // though the request throws), so the 5th wrong attempt locks the code with 429.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await request(app.getHttpServer())
        .post("/api/v1/auth/login/telegram/verify")
        .send({ code: wrongCode, requestId: start.requestId })
        .expect(401)
        .expect(({ body }) => {
          expect(body.code).toBe("TELEGRAM_LOGIN_INVALID");
        });
    }

    await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/verify")
      .send({ code: wrongCode, requestId: start.requestId })
      .expect(429)
      .expect(({ body }) => {
        expect(body.code).toBe("TOO_MANY_REQUESTS");
      });

    // Even the correct code is refused once the code is locked.
    await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/verify")
      .send({ code: retained!.code, requestId: start.requestId })
      .expect(429)
      .expect(({ body }) => {
        expect(body.code).toBe("TOO_MANY_REQUESTS");
      });
  });

  it("rejects login for an unknown Telegram username", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/login/telegram/start")
      .send({ telegramUsername: "definitely_unknown_user" })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("TELEGRAM_LOGIN_FORBIDDEN");
      });
  });
});

function connectionString(container: StartedTestContainer): string {
  return `postgres://${DB.user}:${DB.password}@${container.getHost()}:${container.getMappedPort(
    POSTGRES_PORT,
  )}/${DB.database}`;
}

function runRootScript(scriptPath: string, args: string[], databaseUrl: string): void {
  execFileSync("node", [scriptPath, ...args], {
    cwd: resolve(__dirname, "../../../.."),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: "pipe",
  });
}
