import { OrganizationService } from "../../src/modules/organization/organization.service";
import { UserService } from "../../src/modules/user/user.service";

const ORG_ID = "10000000-0000-4000-8000-000000000101";
const USER_ID = "10000000-0000-4000-8000-000000000201";
const ACTOR_ID = "10000000-0000-4000-8000-000000000202";

interface FakeAudit {
  record: jest.Mock<Promise<void>, [unknown, unknown]>;
}

describe("SVC-IDN M3 audit events", () => {
  it("records user patch, role change, and permission change audit events", async () => {
    const audit = fakeAudit();
    const userRows = [
      userRow({ role_codes: ["manager"], status: "active" }),
      userRow({ role_codes: ["administrator"], status: "blocked" }),
    ];
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM users u")) {
          return { rowCount: 1, rows: [userRows.shift()] };
        }

        if (sql.includes("UPDATE users")) {
          return { rowCount: 1, rows: [] };
        }

        if (sql.includes("SELECT id, code FROM roles")) {
          return {
            rowCount: 1,
            rows: [{ code: "administrator", id: "00000000-0000-4000-8000-000000000002" }],
          };
        }

        return { rowCount: 1, rows: [] };
      }),
    };
    const service = new UserService(fakeDatabase(client), audit as never);

    await service.patchUser(
      ORG_ID,
      USER_ID,
      { roleCodes: ["administrator"], status: "blocked" },
      { actorUserId: ACTOR_ID, requestId: "request-1" },
    );

    expect(audit.record.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        action: "user.patch",
        actorUserId: ACTOR_ID,
        objectId: USER_ID,
        objectType: "user",
        organizationId: ORG_ID,
      }),
      expect.objectContaining({
        action: "access.roles.change",
        metadata: {
          previousRoleCodes: ["manager"],
          roleCodes: ["administrator"],
        },
      }),
      expect.objectContaining({
        action: "access.permissions.change",
        metadata: {
          previousStatus: "active",
          status: "blocked",
        },
      }),
      // Блокировка гасит активные сессии пользователя и фиксирует это в аудите.
      expect.objectContaining({
        action: "auth.session.revoke",
        actorUserId: ACTOR_ID,
        objectId: USER_ID,
        objectType: "user",
        organizationId: ORG_ID,
      }),
    ]);
  });

  it("records session revoke audit events with surrogate session ids", async () => {
    const audit = fakeAudit();
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM users u")) {
          return { rowCount: 1, rows: [userRow()] };
        }

        if (sql.includes("UPDATE auth_sessions")) {
          return {
            rowCount: 2,
            rows: [
              { id: "10000000-0000-4000-8000-000000000901" },
              { id: "10000000-0000-4000-8000-000000000902" },
            ],
          };
        }

        return { rowCount: 1, rows: [] };
      }),
    };
    const service = new UserService(fakeDatabase(client), audit as never);

    const response = await service.revokeUserSessions(ORG_ID, USER_ID, {
      actorUserId: ACTOR_ID,
      requestId: "request-2",
    });

    expect(response).toEqual({
      organizationId: ORG_ID,
      revokedCount: 2,
      userId: USER_ID,
    });
    expect(audit.record).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        action: "auth.session.revoke",
        actorUserId: ACTOR_ID,
        metadata: {
          revokedCount: 2,
          revokedSessionIds: [
            "10000000-0000-4000-8000-000000000901",
            "10000000-0000-4000-8000-000000000902",
          ],
        },
        objectId: USER_ID,
        objectType: "user",
        organizationId: ORG_ID,
      }),
    );
  });

  it("records organization update and block audit events", async () => {
    const audit = fakeAudit();
    const rows = [
      organizationRow({ status: "active" }),
      organizationRow({ status: "blocked" }),
    ];
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM organizations")) {
          return { rowCount: 1, rows: [rows.shift()] };
        }

        if (sql.includes("UPDATE organizations")) {
          return { rowCount: 1, rows: [rows.shift()] };
        }

        return { rowCount: 1, rows: [] };
      }),
    };
    const service = new OrganizationService(fakeDatabase(client), audit as never);

    await service.updateOrganization(
      ORG_ID,
      { status: "blocked" },
      { actorUserId: ACTOR_ID, requestId: "request-3" },
    );

    expect(audit.record.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        action: "organization.update",
        actorUserId: ACTOR_ID,
        objectId: ORG_ID,
        objectType: "organization",
        organizationId: ORG_ID,
      }),
      expect.objectContaining({
        action: "organization.block",
        metadata: {
          previousStatus: "active",
          status: "blocked",
        },
      }),
    ]);
  });
});

function fakeAudit(): FakeAudit {
  return {
    record: jest.fn<Promise<void>, [unknown, unknown]>(async () => undefined),
  };
}

function fakeDatabase(client: { query: jest.Mock }) {
  return {
    withTenant: jest.fn(async (_organizationId: string, callback: (queryable: unknown) => unknown) =>
      callback(client),
    ),
  } as never;
}

function userRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    created_at: "2026-07-03T10:00:00.000Z",
    display_name: "Audit User",
    email: "audit-user@example.bridge.local",
    id: USER_ID,
    organization_id: ORG_ID,
    role_codes: ["manager"],
    status: "active",
    telegram_username: "audit_user",
    updated_at: "2026-07-03T10:00:00.000Z",
    ...overrides,
  };
}

function organizationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    created_at: "2026-07-03T10:00:00.000Z",
    description: "Audit fixture",
    id: ORG_ID,
    locale: "ru-RU",
    name: "Audit Organization",
    status: "active",
    timezone: "UTC",
    updated_at: "2026-07-03T10:00:00.000Z",
    ...overrides,
  };
}
