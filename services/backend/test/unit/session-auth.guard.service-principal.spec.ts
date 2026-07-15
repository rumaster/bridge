import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

import type { PgDatabase } from "../../src/common/database/database.service";
import type { AuthSessionContext } from "../../src/common/auth/auth-context";
import { SessionAuthGuard } from "../../src/common/auth/session-auth.guard";

/**
 * Аутентификация движка Workflow (дефект D4): узел «Вызов Backend API» получал 401,
 * потому что схему запускает событие и человека-инициатора у неё нет.
 *
 * Проверяется разделение, на котором держится решение: токен отвечает «кто ты»,
 * роли техпользователя — «что тебе можно», витрина — «какие вызовы вообще доступны
 * схемам». Каждая из трёх границ проверяется отдельно, иначе зелёный тест мог бы
 * означать, что работает только одна из них.
 */

const SERVICE_TOKEN = "test-service-token";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000101";
const SERVICE_USER_ID = "00000000-0000-4000-8000-000000000202";

interface FakeDatabaseOptions {
  principalRows?: Record<string, unknown>[];
  allowlistRows?: { enabled: boolean }[];
  sessionRows?: Record<string, unknown>[];
}

/**
 * Различает три запроса гуарда по тексту SQL: сервисный принципал (users.is_service),
 * витрина и сессия. Так тест видит, какой из путей был выбран, а не только результат.
 */
function fakeDatabase({
  principalRows = [],
  allowlistRows = [],
  sessionRows = [],
}: FakeDatabaseOptions) {
  const calls: string[] = [];

  const run = (sql: string) => {
    if (sql.includes("workflow_backend_api_allowlist")) {
      calls.push("allowlist");
      return { rowCount: allowlistRows.length, rows: allowlistRows };
    }
    if (sql.includes("u.is_service")) {
      calls.push("principal");
      return { rowCount: principalRows.length, rows: principalRows };
    }
    calls.push("session");
    return { rowCount: sessionRows.length, rows: sessionRows };
  };

  const database = {
    calls,
    async query(sql: string) {
      return run(sql);
    },
    async withTenant<T>(
      _organizationId: string,
      handler: (client: { query: (sql: string) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> {
      return handler({ query: async (sql: string) => run(sql) });
    },
  };

  return database as unknown as PgDatabase & { calls: string[] };
}

function principalRow(roles: string[]) {
  return {
    user_id: SERVICE_USER_ID,
    organization_id: ORGANIZATION_ID,
    display_name: "Workflow Engine (service)",
    user_status: "active",
    organization_name: "Demo Organization",
    organization_status: "active",
    roles,
    role_bindings: roles.map((role) => ({ role, organizationId: ORGANIZATION_ID })),
  };
}

function contextOf(request: Partial<Request>): ExecutionContext {
  const full = {
    method: "GET",
    headers: {},
    query: {},
    params: {},
    ...request,
  } as Request;

  return {
    switchToHttp: () => ({ getRequest: () => full }),
  } as unknown as ExecutionContext;
}

function serviceRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    method: "GET",
    originalUrl: `/api/v1/clients/${SERVICE_USER_ID}`,
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-organization-id": ORGANIZATION_ID,
    },
    ...overrides,
  };
}

function authOf(context: ExecutionContext): AuthSessionContext {
  const request = context.switchToHttp().getRequest<Request & { auth: AuthSessionContext }>();
  return request.auth;
}

describe("SessionAuthGuard: сервисный принципал движка Workflow (D4)", () => {
  const previousToken = process.env.FBP_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.FBP_SERVICE_TOKEN = SERVICE_TOKEN;
  });

  afterAll(() => {
    if (previousToken === undefined) {
      delete process.env.FBP_SERVICE_TOKEN;
    } else {
      process.env.FBP_SERVICE_TOKEN = previousToken;
    }
  });

  it("опознаёт токен и берёт права из ролей техпользователя, а не из токена", async () => {
    const database = fakeDatabase({
      principalRows: [principalRow(["administrator"])],
      allowlistRows: [{ enabled: true }],
    });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(serviceRequest());

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const auth = authOf(context);
    expect(auth.user.id).toBe(SERVICE_USER_ID);
    expect(auth.organization.id).toBe(ORGANIZATION_ID);
    expect(auth.roles).toEqual(["administrator"]);
    // Сессии за принципалом нет — в auth_sessions гуард не ходил.
    expect(database.calls).not.toContain("session");
    // Токен не растекается по контексту.
    expect(auth.token).toBe("");
  });

  it("отбирает platform_operator, даже если роль привязана техпользователю", async () => {
    // Иначе схема открыла бы себе в витрине что угодно, то есть сняла бы
    // собственную границу.
    const database = fakeDatabase({
      principalRows: [principalRow(["administrator", "platform_operator"])],
      allowlistRows: [{ enabled: true }],
    });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(serviceRequest());

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authOf(context).roles).toEqual(["administrator"]);
  });

  it("запрещает вызов, не включённый в витрине", async () => {
    const database = fakeDatabase({
      principalRows: [principalRow(["administrator"])],
      allowlistRows: [{ enabled: false }],
    });
    const guard = new SessionAuthGuard(database);

    await expect(guard.canActivate(contextOf(serviceRequest()))).rejects.toMatchObject({
      response: { code: "BACKEND_API_OPERATION_FORBIDDEN" },
      status: 403,
    });
  });

  it("запрещает вызов, у которого в витрине вообще нет строки (закрыто по умолчанию)", async () => {
    const database = fakeDatabase({
      principalRows: [principalRow(["administrator"])],
      allowlistRows: [],
    });
    const guard = new SessionAuthGuard(database);

    await expect(guard.canActivate(contextOf(serviceRequest()))).rejects.toMatchObject({
      response: { code: "BACKEND_API_OPERATION_FORBIDDEN" },
    });
  });

  it("запрещает маршрут, которого нет в сгенерированном каталоге", async () => {
    // Страховка от РАСХОЖДЕНИЯ каталога, а не от живого маршрута: сегодня все
    // маршруты под SessionAuthGuard лежат под /api/v1 и попадают в каталог из
    // OpenAPI, а несуществующий путь роутер Nest отвергает 404 раньше гуарда
    // (проверено пробником: POST /api/v1/ai/llm/completions → 404, не 403).
    // Ветка срабатывает, если каталог не перегенерировали после нового маршрута
    // либо когда появится /api/v2: и то и другое должно быть закрыто, а не открыто.
    const database = fakeDatabase({
      principalRows: [principalRow(["administrator"])],
      allowlistRows: [{ enabled: true }],
    });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(serviceRequest({ originalUrl: "/api/v2/clients", method: "GET" }));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: "BACKEND_API_OPERATION_FORBIDDEN" },
    });
    // До витрины дело не дошло: маршрута нет в каталоге, проверять нечего.
    expect(database.calls).not.toContain("allowlist");
  });

  it("сообщает SERVICE_PRINCIPAL_MISSING, если техпользователя в организации нет", async () => {
    // Сидом он заводится только для демо-организации; для созданных в рантайме
    // провижининга пока нет — это осознанный остаток этапа 5.
    const database = fakeDatabase({ principalRows: [] });
    const guard = new SessionAuthGuard(database);

    await expect(guard.canActivate(contextOf(serviceRequest()))).rejects.toMatchObject({
      response: { code: "SERVICE_PRINCIPAL_MISSING" },
      status: 401,
    });
  });

  it("требует организацию заголовком и не выводит её из пути или тела", async () => {
    const database = fakeDatabase({ principalRows: [principalRow(["administrator"])] });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(
      serviceRequest({
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        originalUrl: `/api/v1/organizations/${ORGANIZATION_ID}`,
        body: { organization_id: ORGANIZATION_ID },
      }),
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: "SERVICE_ORGANIZATION_REQUIRED" },
    });
    expect(database.calls).toEqual([]);
  });

  it("не пропускает сервисный токен, пока FBP_SERVICE_TOKEN не задан", async () => {
    // Иначе стенд без переменной открыл бы весь /api/v1 по пустому значению.
    delete process.env.FBP_SERVICE_TOKEN;
    const database = fakeDatabase({ principalRows: [principalRow(["administrator"])] });
    const guard = new SessionAuthGuard(database);

    await expect(guard.canActivate(contextOf(serviceRequest()))).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    // Токен ушёл в сессионную ветку, а не в сервисную.
    expect(database.calls).toEqual(["session"]);
  });

  it("не принимает чужой токен за сервисный", async () => {
    const database = fakeDatabase({ principalRows: [principalRow(["administrator"])] });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(
      serviceRequest({
        headers: {
          authorization: "Bearer not-the-service-token",
          "x-organization-id": ORGANIZATION_ID,
        },
      }),
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    expect(database.calls).toEqual(["session"]);
  });

  it("не распространяет витрину на сессии живых людей", async () => {
    // Витрина ограничивает схемы, а не людей: администратор ходит по тем же
    // маршрутам без оглядки на allowlist.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const database = fakeDatabase({
      allowlistRows: [{ enabled: false }],
      sessionRows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: "00000000-0000-4000-8000-000000000201",
          organization_id: ORGANIZATION_ID,
          issued_at: new Date().toISOString(),
          expires_at: expiresAt,
          revoked_at: null,
          telegram_username: "seeded_admin",
          display_name: "Seeded Admin",
          user_status: "active",
          organization_name: "Demo Organization",
          organization_status: "active",
          roles: ["administrator"],
          role_bindings: [{ role: "administrator", organizationId: ORGANIZATION_ID }],
        },
      ],
    });
    const guard = new SessionAuthGuard(database);
    const context = contextOf(
      serviceRequest({
        headers: {
          authorization: "Bearer a-real-session-token",
          "x-organization-id": ORGANIZATION_ID,
        },
      }),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(database.calls).not.toContain("allowlist");
  });
});
