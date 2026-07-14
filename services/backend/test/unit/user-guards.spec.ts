import { ConflictException, ForbiddenException } from "@nestjs/common";

import { UserService } from "../../src/modules/user/user.service";

/**
 * Юнит-тесты защит D1 в UserService.patchUser (без Docker): самоблокировка,
 * самопонижение, защита последнего активного администратора, авто-revoke сессий
 * при блокировке. БД и аудит — in-memory фейки, диспетчеризующие по тексту SQL.
 */

const ORG = "40000000-0000-4000-8000-000000000101";
const ADMIN_A = "40000000-0000-4000-8000-000000000201"; // действующий админ (сессия)
const ADMIN_B = "40000000-0000-4000-8000-000000000202"; // второй админ
const MANAGER = "40000000-0000-4000-8000-000000000301";
const PLATFORM = "40000000-0000-4000-8000-0000000009ff"; // актор вне org-админов

interface FakeUser {
  id: string;
  displayName: string;
  status: string;
  roleCodes: string[];
  email: string | null;
}

const KNOWN_ROLES = new Set(["administrator", "manager"]);

function makeService(seed: FakeUser[], sessionsByUser: Record<string, string[]> = {}) {
  const users = new Map<string, FakeUser>(seed.map((u) => [u.id, { ...u }]));
  const sessions = new Map<string, string[]>(
    Object.entries(sessionsByUser).map(([userId, ids]) => [userId, [...ids]]),
  );
  const audit: string[] = [];

  function userRow(u: FakeUser) {
    return {
      id: u.id,
      organization_id: ORG,
      telegram_username: null,
      telegram_id: null,
      email: u.email,
      display_name: u.displayName,
      status: u.status,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role_codes: u.roleCodes,
    };
  }

  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      // Аутентификация не идёт через сервис — auth_sessions только на revoke.
      if (text.includes("UPDATE auth_sessions")) {
        const [, userId] = values as [string, string];
        const ids = sessions.get(userId) ?? [];
        sessions.set(userId, []);
        return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
      }
      if (text.includes("count(DISTINCT u.id)")) {
        const [, excluded] = values as [string, string];
        const count = [...users.values()].filter(
          (u) => u.id !== excluded && u.status === "active" && u.roleCodes.includes("administrator"),
        ).length;
        return { rowCount: 1, rows: [{ count }] };
      }
      // getUserInTransaction (WHERE id) — вернуть текущее состояние из map.
      if (text.includes("array_agg(r.code") && text.includes("u.id = $2")) {
        const [, userId] = values as [string, string];
        const u = users.get(userId);
        return u ? { rowCount: 1, rows: [userRow(u)] } : { rowCount: 0, rows: [] };
      }
      if (text.includes("UPDATE users")) {
        const userId = values[1] as string;
        const displayName = values[8] as string | null;
        const status = values[9] as string | null;
        const u = users.get(userId);
        if (!u) return { rowCount: 0, rows: [] };
        if (displayName) u.displayName = displayName;
        if (status) u.status = status;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM roles WHERE code = ANY")) {
        const [codes] = values as [string[]];
        const rows = codes
          .filter((c) => KNOWN_ROLES.has(c))
          .map((c) => ({ id: `role-${c}`, code: c }));
        return { rowCount: rows.length, rows };
      }
      if (text.includes("DELETE FROM user_roles")) {
        const [, userId] = values as [string, string];
        const u = users.get(userId);
        if (u) u.roleCodes = [];
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("INSERT INTO user_roles")) {
        const [userId, roleId] = values as [string, string, string];
        const u = users.get(userId);
        if (u) u.roleCodes = [...new Set([...u.roleCodes, String(roleId).replace("role-", "")])].sort();
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const database = {
    async withTenant(_org: string, cb: (c: typeof client) => unknown) {
      return cb(client);
    },
  };
  const auditService = {
    async record(_client: unknown, entry: { action: string }) {
      audit.push(entry.action);
    },
  };

  const service = new UserService(database as never, auditService as never);
  return { service, users, sessions, audit };
}

describe("UserService.patchUser D1 guards", () => {
  it("forbids blocking your own account", async () => {
    const { service } = makeService([
      { id: ADMIN_A, displayName: "Admin A", status: "active", roleCodes: ["administrator"], email: null },
      { id: ADMIN_B, displayName: "Admin B", status: "active", roleCodes: ["administrator"], email: null },
    ]);
    await expect(
      service.patchUser(ORG, ADMIN_A, { status: "blocked" }, { authenticatedUserId: ADMIN_A }),
    ).rejects.toMatchObject({ response: { code: "USER_SELF_MUTATION_FORBIDDEN" } });
    await expect(
      service.patchUser(ORG, ADMIN_A, { status: "blocked" }, { authenticatedUserId: ADMIN_A }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("forbids removing the administrator role from yourself", async () => {
    const { service } = makeService([
      { id: ADMIN_A, displayName: "Admin A", status: "active", roleCodes: ["administrator"], email: null },
      { id: ADMIN_B, displayName: "Admin B", status: "active", roleCodes: ["administrator"], email: null },
    ]);
    await expect(
      service.patchUser(ORG, ADMIN_A, { roleCodes: ["manager"] }, { authenticatedUserId: ADMIN_A }),
    ).rejects.toMatchObject({ response: { code: "USER_SELF_MUTATION_FORBIDDEN" } });
  });

  it("protects the last active administrator from being blocked", async () => {
    // Актор — платформенный оператор (не org-админ), блокирует единственного админа.
    const { service } = makeService([
      { id: ADMIN_A, displayName: "Only Admin", status: "active", roleCodes: ["administrator"], email: null },
      { id: MANAGER, displayName: "Manager", status: "active", roleCodes: ["manager"], email: null },
    ]);
    await expect(
      service.patchUser(ORG, ADMIN_A, { status: "blocked" }, { authenticatedUserId: PLATFORM }),
    ).rejects.toMatchObject({ response: { code: "LAST_ADMINISTRATOR_PROTECTED" } });
    await expect(
      service.patchUser(ORG, ADMIN_A, { status: "blocked" }, { authenticatedUserId: PLATFORM }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("blocks another administrator when others remain, and revokes their sessions", async () => {
    const { service, users, sessions, audit } = makeService(
      [
        { id: ADMIN_A, displayName: "Admin A", status: "active", roleCodes: ["administrator"], email: null },
        { id: ADMIN_B, displayName: "Admin B", status: "active", roleCodes: ["administrator"], email: null },
      ],
      { [ADMIN_B]: ["s1", "s2"] },
    );
    const result = await service.patchUser(
      ORG,
      ADMIN_B,
      { status: "blocked" },
      { authenticatedUserId: ADMIN_A },
    );
    expect(result.status).toBe("blocked");
    expect(users.get(ADMIN_B)!.status).toBe("blocked");
    expect(sessions.get(ADMIN_B)).toEqual([]); // сессии погашены
    expect(audit).toContain("auth.session.revoke");
  });

  it("blocks a manager without guard interference", async () => {
    const { service, users } = makeService([
      { id: ADMIN_A, displayName: "Admin A", status: "active", roleCodes: ["administrator"], email: null },
      { id: MANAGER, displayName: "Manager", status: "active", roleCodes: ["manager"], email: null },
    ]);
    const result = await service.patchUser(
      ORG,
      MANAGER,
      { status: "blocked" },
      { authenticatedUserId: ADMIN_A },
    );
    expect(result.status).toBe("blocked");
    expect(users.get(MANAGER)!.status).toBe("blocked");
  });
});
