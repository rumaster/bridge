import {
  randomBytes,
  randomInt,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  validateAcceptInvitationRequest,
  validateCreateInvitationRequest,
  validateCreateOrganizationAdministratorRequest,
  validatePlatformOrganizationProvisionRequest,
  validateTelegramLoginStartRequest,
  validateTelegramLoginVerifyRequest,
} from "./dto/auth-dto.mjs";
import { SEEDED_AUTH_CONTEXT } from "./seeded-auth-context.mjs";

const TELEGRAM_LOGIN_PURPOSE = "telegram_login";
const DEFAULT_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_HASH_SECRET = "bridge-local-dev-auth-secret";

export const IDENTITY_AUDIT_ACTIONS = Object.freeze({
  invitationAccept: "invitation.accept",
  invitationCreate: "invitation.create",
  loginFailure: "auth.login.failure",
  loginStart: "auth.login.start",
  loginSuccess: "auth.login.success",
  organizationBlock: "organization.block",
  organizationProvision: "organization.provision",
  sessionLogout: "auth.session.logout",
  sessionRevoke: "auth.session.revoke",
});

const ROLE_RECORDS = Object.freeze([
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000001",
    code: "platform_operator",
    scope: "platform",
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000002",
    code: "administrator",
    scope: "organization",
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000003",
    code: "manager",
    scope: "organization",
  }),
]);

function toIsoDate(value) {
  return new Date(value).toISOString();
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function isAfter(date, boundary) {
  return new Date(date).getTime() > new Date(boundary).getTime();
}

function isOnOrBefore(date, boundary) {
  return new Date(date).getTime() <= new Date(boundary).getTime();
}

function problem(status, title, detail, extra = {}) {
  return {
    status,
    body: {
      type: `https://bridge.local/problems/${title
        .toLowerCase()
        .replaceAll(" ", "-")}`,
      title,
      status,
      detail,
      ...extra,
    },
  };
}

function validationProblem(errors) {
  return problem(
    400,
    "Validation failed",
    "Request payload does not match C3.auth DTO.",
    { errors },
  );
}

function unauthorized(detail = "Authentication is required.") {
  return problem(401, "Unauthorized", detail);
}

function forbidden(detail = "Insufficient permissions.") {
  return problem(403, "Forbidden", detail);
}

function tooManyRequests(detail, retryAfterSeconds) {
  return problem(429, "Too Many Requests", detail, {
    retryAfterSeconds,
  });
}

function normalizeIso(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createDefaultCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function createDefaultToken() {
  return `brs_${randomBytes(32).toString("base64url")}`;
}

function createDefaultInvitationToken() {
  return `bri_${randomBytes(32).toString("base64url")}`;
}

function hashSecretValue({ secret, purpose, subject, value }) {
  return `sha256:${createHmac("sha256", secret)
    .update(`${purpose}:${subject}:${value}`)
    .digest("hex")}`;
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function primaryRole(roles) {
  if (roles.includes("administrator")) {
    return "administrator";
  }

  if (roles.includes("manager")) {
    return "manager";
  }

  return roles[0] ?? null;
}

function roleAllowed(authContext, allowedRoles) {
  const roles = new Set(authContext?.roles ?? []);

  if (roles.has("administrator")) {
    roles.add("manager");
  }

  return allowedRoles.some((role) => roles.has(role));
}

function requireRole(authContext, allowedRoles) {
  if (!authContext?.authenticated || !authContext?.user) {
    return unauthorized("Authentication is required.");
  }

  if (!roleAllowed(authContext, allowedRoles)) {
    return forbidden(`Required role: ${allowedRoles.join(" or ")}.`);
  }

  return null;
}

function hasRoleBinding(record) {
  return Array.isArray(record?.roles) && record.roles.length > 0;
}

function sessionResponse(authContext, token, implementationStage = "M1") {
  return {
    authenticated: true,
    token,
    expiresAt: authContext.session.expiresAt,
    user: {
      ...authContext.user,
      role: primaryRole(authContext.roles),
    },
    organization: authContext.organization,
    roles: [...authContext.roles],
    roleBindings: [...authContext.roleBindings],
    session: authContext.session,
    implementationStage,
  };
}

function seededUserRecord() {
  return {
    user: {
      id: SEEDED_AUTH_CONTEXT.user.id,
      organizationId: SEEDED_AUTH_CONTEXT.user.organizationId,
      telegramUsername: SEEDED_AUTH_CONTEXT.user.telegramUsername,
      email: SEEDED_AUTH_CONTEXT.user.email ?? null,
      displayName: SEEDED_AUTH_CONTEXT.user.displayName,
      status: SEEDED_AUTH_CONTEXT.user.status,
    },
    organization: {
      id: SEEDED_AUTH_CONTEXT.organization.id,
      slug: SEEDED_AUTH_CONTEXT.organization.slug,
      name: SEEDED_AUTH_CONTEXT.organization.name,
      status: SEEDED_AUTH_CONTEXT.organization.status,
    },
    roles: [...SEEDED_AUTH_CONTEXT.roles],
  };
}

function toAuthContext(sessionRecord) {
  const roles = [...sessionRecord.roles];
  const roleBindings = roles.map((role) => ({
    role,
    organizationId: sessionRecord.organization.id,
  }));

  return {
    mode: "server",
    source: "SVC-IDN M1 auth_sessions",
    user: sessionRecord.user,
    organization: sessionRecord.organization,
    roles,
    roleBindings,
    session: {
      id: sessionRecord.id,
      mode: "server",
      issuedAt: normalizeIso(sessionRecord.issuedAt),
      expiresAt: normalizeIso(sessionRecord.expiresAt),
      revokedAt: normalizeIso(sessionRecord.revokedAt),
    },
  };
}

export function createMockTelegramCodeDeliveryAdapter() {
  const deliveries = [];

  return {
    deliveries,

    async deliverTelegramLoginCode(delivery) {
      deliveries.push({
        ...delivery,
      });

      return {
        deliveryChannel: "telegram",
        status: "mock_code_delivery_scheduled",
      };
    },
  };
}

export function createMemoryRateLimiter({
  limit = DEFAULT_RATE_LIMIT,
  now = () => new Date(),
  windowSeconds = DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
} = {}) {
  const buckets = new Map();

  return {
    hit(key) {
      const currentTime = now().getTime();
      const windowMs = windowSeconds * 1000;
      const bucket = buckets.get(key);

      if (!bucket || currentTime >= bucket.resetAt) {
        buckets.set(key, {
          count: 1,
          resetAt: currentTime + windowMs,
        });

        return {
          allowed: true,
          remaining: limit - 1,
          retryAfterSeconds: 0,
        };
      }

      if (bucket.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil((bucket.resetAt - currentTime) / 1000),
        };
      }

      bucket.count += 1;

      return {
        allowed: true,
        remaining: limit - bucket.count,
        retryAfterSeconds: 0,
      };
    },
  };
}

export function createInMemoryAuditRecorder() {
  const events = [];

  return {
    events,

    async record(event) {
      events.push(structuredClone({
        ...event,
        metadata: event.metadata ?? {},
      }));
    },
  };
}

export function createNoopAuditRecorder() {
  return {
    async record() {},
  };
}

export function createInMemoryIdentityStore({
  users = [seededUserRecord()],
} = {}) {
  const organizations = new Map();
  const invitations = new Map();
  const invitationsByTokenHash = new Map();
  const usersById = new Map();
  const usersByTelegram = new Map();
  const loginCodes = new Map();
  const sessions = new Map();

  for (const userRecord of users) {
    upsertUserRecord(userRecord);
  }

  return {
    async createOrganization(record) {
      const organization = {
        ...record,
        slug: slugify(record.name),
        status: record.status ?? "active",
      };
      organizations.set(organization.id, organization);

      return cloneOrNull(organization);
    },

    async findOrganizationById(id) {
      return cloneOrNull(organizations.get(id));
    },

    async updateOrganizationStatus(id, { status, updatedAt }) {
      const organization = organizations.get(id);

      if (!organization) {
        return null;
      }

      organization.status = status;
      organization.updatedAt = updatedAt;

      return cloneOrNull(organization);
    },

    async findRoleByCode(code) {
      return cloneOrNull(ROLE_RECORDS.find((role) => role.code === code));
    },

    async countUsersByRole({ organizationId, roleCode }) {
      return [...usersById.values()].filter(
        (record) =>
          record.user.organizationId === organizationId &&
          record.roles.includes(roleCode),
      ).length;
    },

    async countPendingInvitationsByRole({ organizationId, now: currentTime, roleCode }) {
      return [...invitations.values()].filter(
        (record) =>
          record.organizationId === organizationId &&
          record.roleCode === roleCode &&
          !record.acceptedAt &&
          isAfter(record.expiresAt, currentTime),
      ).length;
    },

    async findUserByTelegramUsername(telegramUsername) {
      return cloneOrNull(usersByTelegram.get(telegramUsername.toLowerCase()));
    },

    async findUserById(userId) {
      return cloneOrNull(usersById.get(userId));
    },

    async createLoginCode(record) {
      loginCodes.set(record.id, {
        ...record,
        attemptCount: record.attemptCount ?? 0,
        lockedUntil: record.lockedUntil ?? null,
        consumedAt: record.consumedAt ?? null,
      });

      return cloneOrNull(loginCodes.get(record.id));
    },

    async findLoginCodeById(id) {
      return cloneOrNull(loginCodes.get(id));
    },

    async findLatestLoginCodeByUser({ userId, purpose }) {
      return cloneOrNull(
        [...loginCodes.values()]
          .filter((record) => record.userId === userId && record.purpose === purpose)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0],
      );
    },

    async updateLoginCodeAttempts(id, { attemptCount, lockedUntil }) {
      const record = loginCodes.get(id);

      if (!record) {
        return null;
      }

      record.attemptCount = attemptCount;
      record.lockedUntil = lockedUntil;

      return cloneOrNull(record);
    },

    async consumeLoginCode(id, consumedAt) {
      const record = loginCodes.get(id);

      if (!record || record.consumedAt) {
        return null;
      }

      record.consumedAt = consumedAt;

      return cloneOrNull(record);
    },

    async createAuthSession(record) {
      sessions.set(record.tokenHash, {
        ...record,
        revokedAt: record.revokedAt ?? null,
      });

      return cloneOrNull(sessions.get(record.tokenHash));
    },

    async findSessionByTokenHash(tokenHash) {
      return cloneOrNull(sessions.get(tokenHash));
    },

    async revokeSession(id, revokedAt) {
      for (const session of sessions.values()) {
        if (session.id === id) {
          session.revokedAt = revokedAt;
          return cloneOrNull(session);
        }
      }

      return null;
    },

    async createInvitation(record) {
      const role = ROLE_RECORDS.find((item) => item.id === record.roleId);
      const invitation = {
        ...record,
        acceptedAt: record.acceptedAt ?? null,
        createdBy: record.createdBy ?? null,
        roleCode: role?.code ?? record.roleCode,
      };

      invitations.set(invitation.id, invitation);
      invitationsByTokenHash.set(invitation.tokenHash, invitation.id);

      return cloneOrNull(invitation);
    },

    async findInvitationByTokenHash(tokenHash) {
      const id = invitationsByTokenHash.get(tokenHash);

      return cloneOrNull(id ? invitations.get(id) : null);
    },

    async consumeInvitation(id, acceptedAt) {
      const invitation = invitations.get(id);

      if (!invitation || invitation.acceptedAt) {
        return null;
      }

      invitation.acceptedAt = acceptedAt;

      return cloneOrNull(invitation);
    },

    async createUserFromInvitation({ displayName, id, invitation }) {
      const organization = organizations.get(invitation.organizationId);

      if (!organization) {
        return null;
      }

      const userRecord = {
        user: {
          id,
          organizationId: invitation.organizationId,
          telegramUsername:
            invitation.contactType === "telegram" ? invitation.contactValue : null,
          email: invitation.contactType === "email" ? invitation.contactValue : null,
          displayName,
          status: "active",
        },
        organization: {
          id: organization.id,
          slug: organization.slug ?? slugify(organization.name),
          name: organization.name,
          status: organization.status,
        },
        roles: [invitation.roleCode],
      };

      upsertUserRecord(userRecord);

      return cloneOrNull(userRecord);
    },
  };

  function upsertUserRecord(userRecord) {
    const record = structuredClone(userRecord);
    usersById.set(record.user.id, record);

    if (record.user.telegramUsername) {
      usersByTelegram.set(record.user.telegramUsername.toLowerCase(), record);
    }

    if (record.organization?.id) {
      organizations.set(record.organization.id, {
        id: record.organization.id,
        slug: record.organization.slug ?? slugify(record.organization.name),
        name: record.organization.name,
        description: record.organization.description ?? null,
        timezone: record.organization.timezone ?? "UTC",
        locale: record.organization.locale ?? "ru-RU",
        status: record.organization.status,
        createdAt:
          record.organization.createdAt ?? "2026-01-01T00:00:00.000Z",
        updatedAt:
          record.organization.updatedAt ?? "2026-01-01T00:00:00.000Z",
      });
    }
  }
}

function cloneOrNull(value) {
  if (!value) {
    return null;
  }

  return structuredClone(value);
}

export function createPostgresIdentityStore({ client }) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("createPostgresIdentityStore requires a pg client.");
  }

  return {
    async findUserByTelegramUsername(telegramUsername) {
      const result = await client.query(
        `
          SELECT
            u.id,
            u.organization_id,
            u.telegram_username,
            u.email,
            u.display_name,
            u.status,
            o.id AS organization_id,
            o.name AS organization_name,
            o.status AS organization_status,
            COALESCE(
              array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
              '{}'::text[]
            ) AS roles
          FROM users u
          JOIN organizations o ON o.id = u.organization_id
          LEFT JOIN user_roles ur
            ON ur.user_id = u.id AND ur.organization_id = u.organization_id
          LEFT JOIN roles r ON r.id = ur.role_id
          WHERE lower(u.telegram_username) = lower($1)
          GROUP BY u.id, o.id
          LIMIT 1
        `,
        [telegramUsername],
      );

      if (result.rowCount === 0) {
        return null;
      }

      return mapUserRow(result.rows[0]);
    },

    async findUserById(userId) {
      const result = await client.query(
        `
          SELECT
            u.id,
            u.organization_id,
            u.telegram_username,
            u.email,
            u.display_name,
            u.status,
            o.id AS organization_id,
            o.name AS organization_name,
            o.status AS organization_status,
            COALESCE(
              array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
              '{}'::text[]
            ) AS roles
          FROM users u
          JOIN organizations o ON o.id = u.organization_id
          LEFT JOIN user_roles ur
            ON ur.user_id = u.id AND ur.organization_id = u.organization_id
          LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.id = $1
          GROUP BY u.id, o.id
          LIMIT 1
        `,
        [userId],
      );

      return result.rowCount === 0 ? null : mapUserRow(result.rows[0]);
    },

    async createLoginCode(record) {
      const result = await client.query(
        `
          INSERT INTO login_codes (
            id,
            user_id,
            organization_id,
            code_hash,
            purpose,
            expires_at,
            consumed_at,
            attempt_count,
            locked_until,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::timestamptz, $10::timestamptz)
          RETURNING *
        `,
        [
          record.id,
          record.userId,
          record.organizationId,
          record.codeHash,
          record.purpose,
          record.expiresAt,
          record.consumedAt,
          record.attemptCount ?? 0,
          record.lockedUntil,
          record.createdAt,
        ],
      );

      return mapLoginCodeRow(result.rows[0]);
    },

    async findLoginCodeById(id) {
      const result = await client.query(
        "SELECT * FROM login_codes WHERE id = $1",
        [id],
      );

      return result.rowCount === 0 ? null : mapLoginCodeRow(result.rows[0]);
    },

    async findLatestLoginCodeByUser({ userId, purpose }) {
      const result = await client.query(
        `
          SELECT *
          FROM login_codes
          WHERE user_id = $1 AND purpose = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [userId, purpose],
      );

      return result.rowCount === 0 ? null : mapLoginCodeRow(result.rows[0]);
    },

    async updateLoginCodeAttempts(id, { attemptCount, lockedUntil }) {
      const result = await client.query(
        `
          UPDATE login_codes
          SET attempt_count = $2,
              locked_until = $3::timestamptz
          WHERE id = $1
          RETURNING *
        `,
        [id, attemptCount, lockedUntil],
      );

      return result.rowCount === 0 ? null : mapLoginCodeRow(result.rows[0]);
    },

    async consumeLoginCode(id, consumedAt) {
      const result = await client.query(
        `
          UPDATE login_codes
          SET consumed_at = $2::timestamptz
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING *
        `,
        [id, consumedAt],
      );

      return result.rowCount === 0 ? null : mapLoginCodeRow(result.rows[0]);
    },

    async createAuthSession(record) {
      const result = await client.query(
        `
          INSERT INTO auth_sessions (
            id,
            user_id,
            organization_id,
            token_hash,
            issued_at,
            expires_at,
            revoked_at,
            ip,
            user_agent
          )
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::inet, $9)
          RETURNING *
        `,
        [
          record.id,
          record.user.id,
          record.user.organizationId,
          record.tokenHash,
          record.issuedAt,
          record.expiresAt,
          record.revokedAt,
          record.ip,
          record.userAgent,
        ],
      );

      return {
        ...record,
        ...mapAuthSessionRow(result.rows[0]),
      };
    },

    async findSessionByTokenHash(tokenHash) {
      const result = await client.query(
        `
          SELECT
            s.id,
            s.user_id,
            s.organization_id,
            s.token_hash,
            s.issued_at,
            s.expires_at,
            s.revoked_at,
            s.ip,
            s.user_agent,
            u.telegram_username,
            u.email,
            u.display_name,
            u.status AS user_status,
            o.name AS organization_name,
            o.status AS organization_status,
            COALESCE(
              array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
              '{}'::text[]
            ) AS roles
          FROM auth_sessions s
          JOIN users u ON u.id = s.user_id AND u.organization_id = s.organization_id
          JOIN organizations o ON o.id = s.organization_id
          LEFT JOIN user_roles ur
            ON ur.user_id = u.id AND ur.organization_id = u.organization_id
          LEFT JOIN roles r ON r.id = ur.role_id
          WHERE s.token_hash = $1
          GROUP BY s.id, u.id, o.id
          LIMIT 1
        `,
        [tokenHash],
      );

      return result.rowCount === 0 ? null : mapSessionJoinRow(result.rows[0]);
    },

    async revokeSession(id, revokedAt) {
      const result = await client.query(
        `
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
          WHERE id = $1
          RETURNING *
        `,
        [id, revokedAt],
      );

      return result.rowCount === 0 ? null : mapAuthSessionRow(result.rows[0]);
    },

    async createOrganization(record) {
      const result = await client.query(
        `
          INSERT INTO organizations (
            id,
            name,
            description,
            timezone,
            locale,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
          RETURNING id, name, description, timezone, locale, status, created_at, updated_at
        `,
        [
          record.id,
          record.name,
          record.description,
          record.timezone,
          record.locale,
          record.status,
          record.createdAt,
          record.updatedAt,
        ],
      );

      return mapOrganizationRow(result.rows[0]);
    },

    async findOrganizationById(id) {
      const result = await client.query(
        `
          SELECT id, name, description, timezone, locale, status, created_at, updated_at
          FROM organizations
          WHERE id = $1
        `,
        [id],
      );

      return result.rowCount === 0 ? null : mapOrganizationRow(result.rows[0]);
    },

    async updateOrganizationStatus(id, { status, updatedAt }) {
      const result = await client.query(
        `
          UPDATE organizations
          SET status = $2,
              updated_at = $3::timestamptz
          WHERE id = $1
          RETURNING id, name, description, timezone, locale, status, created_at, updated_at
        `,
        [id, status, updatedAt],
      );

      return result.rowCount === 0 ? null : mapOrganizationRow(result.rows[0]);
    },

    async findRoleByCode(code) {
      const result = await client.query(
        "SELECT id, code, scope FROM roles WHERE code = $1 LIMIT 1",
        [code],
      );

      return result.rowCount === 0 ? null : mapRoleRow(result.rows[0]);
    },

    async countUsersByRole({ organizationId, roleCode }) {
      const result = await client.query(
        `
          SELECT count(*)::int AS count
          FROM users u
          JOIN user_roles ur
            ON ur.user_id = u.id AND ur.organization_id = u.organization_id
          JOIN roles r ON r.id = ur.role_id
          WHERE u.organization_id = $1 AND r.code = $2
        `,
        [organizationId, roleCode],
      );

      return result.rows[0].count;
    },

    async countPendingInvitationsByRole({ organizationId, now: currentTime, roleCode }) {
      const result = await client.query(
        `
          SELECT count(*)::int AS count
          FROM invitations i
          JOIN roles r ON r.id = i.role_id
          WHERE i.organization_id = $1
            AND r.code = $2
            AND i.accepted_at IS NULL
            AND i.expires_at > $3::timestamptz
        `,
        [organizationId, roleCode, currentTime],
      );

      return result.rows[0].count;
    },

    async createInvitation(record) {
      const result = await client.query(
        `
          INSERT INTO invitations (
            id,
            organization_id,
            contact_type,
            contact_value,
            role_id,
            token_hash,
            expires_at,
            accepted_at,
            created_by,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10::timestamptz)
          RETURNING *
        `,
        [
          record.id,
          record.organizationId,
          record.contactType,
          record.contactValue,
          record.roleId,
          record.tokenHash,
          record.expiresAt,
          record.acceptedAt,
          record.createdBy,
          record.createdAt,
        ],
      );

      return {
        ...mapInvitationRow(result.rows[0]),
        roleCode: record.roleCode,
      };
    },

    async findInvitationByTokenHash(tokenHash) {
      const result = await client.query(
        `
          SELECT
            i.*,
            r.code AS role_code,
            o.name AS organization_name,
            o.status AS organization_status
          FROM invitations i
          JOIN roles r ON r.id = i.role_id
          JOIN organizations o ON o.id = i.organization_id
          WHERE i.token_hash = $1
          LIMIT 1
        `,
        [tokenHash],
      );

      return result.rowCount === 0 ? null : mapInvitationRow(result.rows[0]);
    },

    async consumeInvitation(id, acceptedAt) {
      const result = await client.query(
        `
          UPDATE invitations
          SET accepted_at = $2::timestamptz
          WHERE id = $1 AND accepted_at IS NULL
          RETURNING *
        `,
        [id, acceptedAt],
      );

      return result.rowCount === 0 ? null : mapInvitationRow(result.rows[0]);
    },

    async createUserFromInvitation({ displayName, id, invitation }) {
      await client.query(
        `
          INSERT INTO users (
            id,
            organization_id,
            telegram_username,
            email,
            display_name,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
        `,
        [
          id,
          invitation.organizationId,
          invitation.contactType === "telegram" ? invitation.contactValue : null,
          invitation.contactType === "email" ? invitation.contactValue : null,
          displayName,
        ],
      );
      await client.query(
        `
          INSERT INTO user_roles (user_id, role_id, organization_id)
          VALUES ($1, $2, $3)
        `,
        [id, invitation.roleId, invitation.organizationId],
      );

      const result = await client.query(
        `
          SELECT
            u.id,
            u.organization_id,
            u.telegram_username,
            u.email,
            u.display_name,
            u.status,
            o.id AS organization_id,
            o.name AS organization_name,
            o.status AS organization_status,
            ARRAY[$3::text] AS roles
          FROM users u
          JOIN organizations o ON o.id = u.organization_id
          WHERE u.id = $1 AND u.organization_id = $2
          LIMIT 1
        `,
        [id, invitation.organizationId, invitation.roleCode],
      );

      return result.rowCount === 0 ? null : mapUserRow(result.rows[0]);
    },
  };
}

export function createPostgresAuditRecorder({ client }) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("createPostgresAuditRecorder requires a pg client.");
  }

  return {
    async record(input) {
      await client.query(
        `
          INSERT INTO audit_events (
            id,
            organization_id,
            actor_user_id,
            actor_type,
            action,
            object_type,
            object_id,
            result,
            request_id,
            ip,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11::jsonb)
        `,
        [
          randomUUID(),
          input.organizationId,
          input.actorUserId ?? null,
          input.actorType ?? "user",
          input.action,
          input.objectType,
          input.objectId ?? null,
          input.result ?? "success",
          input.requestId ?? null,
          input.ip ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
    },
  };
}

function mapUserRow(row) {
  return {
    user: {
      id: row.id,
      organizationId: row.organization_id,
      telegramUsername: row.telegram_username,
      email: row.email ?? null,
      displayName: row.display_name,
      status: row.status,
    },
    organization: {
      id: row.organization_id,
      slug: slugify(row.organization_name),
      name: row.organization_name,
      status: row.organization_status,
    },
    roles: row.roles,
  };
}

function mapLoginCodeRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    codeHash: row.code_hash,
    purpose: row.purpose,
    expiresAt: normalizeIso(row.expires_at),
    consumedAt: normalizeIso(row.consumed_at),
    createdAt: normalizeIso(row.created_at),
    attemptCount: row.attempt_count,
    lockedUntil: normalizeIso(row.locked_until),
  };
}

function mapAuthSessionRow(row) {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    issuedAt: normalizeIso(row.issued_at),
    expiresAt: normalizeIso(row.expires_at),
    revokedAt: normalizeIso(row.revoked_at),
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

function mapSessionJoinRow(row) {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    issuedAt: normalizeIso(row.issued_at),
    expiresAt: normalizeIso(row.expires_at),
    revokedAt: normalizeIso(row.revoked_at),
    ip: row.ip,
    userAgent: row.user_agent,
    user: {
      id: row.user_id,
      organizationId: row.organization_id,
      telegramUsername: row.telegram_username,
      email: row.email ?? null,
      displayName: row.display_name,
      status: row.user_status,
    },
    organization: {
      id: row.organization_id,
      slug: slugify(row.organization_name),
      name: row.organization_name,
      status: row.organization_status,
    },
    roles: row.roles,
  };
}

function mapOrganizationRow(row) {
  return {
    id: row.id,
    slug: slugify(row.name),
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    locale: row.locale,
    status: row.status,
    createdAt: normalizeIso(row.created_at),
    updatedAt: normalizeIso(row.updated_at),
  };
}

function mapRoleRow(row) {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope,
  };
}

function mapInvitationRow(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contactType: row.contact_type,
    contactValue: row.contact_value,
    roleId: row.role_id,
    roleCode:
      row.role_code ?? ROLE_RECORDS.find((role) => role.id === row.role_id)?.code,
    tokenHash: row.token_hash,
    expiresAt: normalizeIso(row.expires_at),
    acceptedAt: normalizeIso(row.accepted_at),
    createdBy: row.created_by,
    createdAt: normalizeIso(row.created_at),
    organization: row.organization_name
      ? {
          id: row.organization_id,
          slug: slugify(row.organization_name),
          name: row.organization_name,
          status: row.organization_status,
        }
      : undefined,
  };
}

function organizationResponse(organization) {
  return {
    id: organization.id,
    name: organization.name,
    description: organization.description ?? null,
    timezone: organization.timezone ?? "UTC",
    locale: organization.locale ?? "ru-RU",
    status: organization.status,
    createdAt: normalizeIso(organization.createdAt),
    updatedAt: normalizeIso(organization.updatedAt),
    implementationStage: "M4",
  };
}

function invitationResponse(invitation) {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    contactType: invitation.contactType,
    contactValue: invitation.contactValue,
    roleCode: invitation.roleCode,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    createdBy: invitation.createdBy ?? null,
    createdAt: invitation.createdAt,
    implementationStage: "M4",
  };
}

export function createIdentityService({
  auditRecorder = createNoopAuditRecorder(),
  codeGenerator = createDefaultCode,
  codeTtlSeconds = DEFAULT_CODE_TTL_SECONDS,
  deliveryAdapter = createMockTelegramCodeDeliveryAdapter(),
  hashSecret = process.env.BRIDGE_AUTH_SECRET ?? DEFAULT_HASH_SECRET,
  invitationTokenGenerator = createDefaultInvitationToken,
  invitationTtlSeconds = DEFAULT_INVITATION_TTL_SECONDS,
  lockoutSeconds = DEFAULT_LOCKOUT_SECONDS,
  maxVerifyAttempts = DEFAULT_MAX_VERIFY_ATTEMPTS,
  now = () => new Date(),
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  startRateLimiter = createMemoryRateLimiter({ now }),
  store = createInMemoryIdentityStore(),
  tokenGenerator = createDefaultToken,
  verifyRateLimiter = createMemoryRateLimiter({ now }),
} = {}) {
  function hashLoginCode({ userId, code }) {
    return hashSecretValue({
      secret: hashSecret,
      purpose: TELEGRAM_LOGIN_PURPOSE,
      subject: userId,
      value: code,
    });
  }

  function hashSessionToken(token) {
    return hashSecretValue({
      secret: hashSecret,
      purpose: "auth_session",
      subject: "server",
      value: token,
    });
  }

  function hashInvitationToken(token) {
    return hashSecretValue({
      secret: hashSecret,
      purpose: "invitation",
      subject: "server",
      value: token,
    });
  }

  async function getSessionByToken(token) {
    if (!token) {
      return unauthorized("Session token is missing.");
    }

    const tokenHash = hashSessionToken(token);
    const session = await store.findSessionByTokenHash(tokenHash);

    if (!session) {
      return unauthorized("Session token is invalid.");
    }

    const currentTime = now();

    if (session.revokedAt) {
      return unauthorized("Session has been revoked.");
    }

    if (isOnOrBefore(session.expiresAt, currentTime)) {
      return unauthorized("Session has expired.");
    }

    if (session.user.status !== "active") {
      return unauthorized("User is not active.");
    }

    if (session.organization.status !== "active") {
      return unauthorized("Organization is not active.");
    }

    if (!hasRoleBinding(session)) {
      return unauthorized("Session has no active role binding.");
    }

    const authContext = toAuthContext(session);

    return {
      status: 200,
      body: sessionResponse(authContext, token),
    };
  }

  async function recordAuditEvent({
    action,
    actorUserId,
    authMethod = "telegram",
    ip,
    metadata = {},
    objectId,
    objectType,
    organizationId,
    requestId,
    result = "success",
  }) {
    if (!organizationId) {
      return;
    }

    await auditRecorder.record({
      action,
      actorType: "user",
      actorUserId,
      ip,
      metadata: authMethod ? { authMethod, ...metadata } : { ...metadata },
      objectId,
      objectType,
      organizationId,
      requestId,
      result,
    });
  }

  async function recordLoginFailure({
    failureResult = "failure",
    loginCode,
    reason,
    request = {},
    userRecord,
  }) {
    const organizationId =
      userRecord?.user?.organizationId ?? loginCode?.organizationId;
    const actorUserId = userRecord?.user?.id ?? loginCode?.userId;
    const objectId = loginCode?.id ?? actorUserId;
    const objectType = loginCode ? "login_code" : "user";

    await recordAuditEvent({
      action: IDENTITY_AUDIT_ACTIONS.loginFailure,
      actorUserId,
      ip: request.ip ?? null,
      metadata: {
        reason,
        ...(loginCode
          ? {
              attemptCount: loginCode.attemptCount,
              locked: Boolean(loginCode.lockedUntil),
            }
          : {}),
      },
      objectId,
      objectType,
      organizationId,
      requestId: loginCode?.id,
      result: failureResult,
    });
  }

  async function createInvitationRecord({
    authContext,
    createdBy,
    organizationId,
    platformActorUserId,
    value,
  }) {
    const organization = await store.findOrganizationById(organizationId);
    if (!organization) {
      return problem(404, "Not Found", "Organization was not found.");
    }

    if (organization.status !== "active") {
      return unauthorized("Organization is not active.");
    }

    const role = await store.findRoleByCode(value.roleCode);
    if (!role) {
      return validationProblem([
        {
          field: "roleCode",
          message: "Invitation roleCode does not exist.",
        },
      ]);
    }

    const token = invitationTokenGenerator();
    const currentTime = now();
    const expiresInSeconds = value.expiresInSeconds ?? invitationTtlSeconds;
    const expiresAt = addSeconds(currentTime, expiresInSeconds);
    const invitation = await store.createInvitation({
      id: randomUUID(),
      organizationId,
      contactType: value.contactType,
      contactValue: value.contactValue,
      displayName: value.displayName,
      roleId: role.id,
      roleCode: role.code,
      tokenHash: hashInvitationToken(token),
      expiresAt: toIsoDate(expiresAt),
      acceptedAt: null,
      createdBy,
      createdAt: toIsoDate(currentTime),
    });

    await recordAuditEvent({
      action: IDENTITY_AUDIT_ACTIONS.invitationCreate,
      actorUserId: createdBy,
      authMethod: null,
      metadata: {
        contactType: invitation.contactType,
        expiresAt: invitation.expiresAt,
        platformActorUserId,
        roleCode: invitation.roleCode,
      },
      objectId: invitation.id,
      objectType: "invitation",
      organizationId,
      requestId: invitation.id,
    });

    return {
      status: 201,
      body: {
        ...invitationResponse(invitation),
        token,
      },
    };
  }

  return {
    hashInvitationToken,
    hashLoginCode,
    hashSessionToken,

    async provisionOrganization(payload, authContext) {
      const authorization = requireRole(authContext, ["platform_operator"]);
      if (authorization) {
        return authorization;
      }

      const result = validatePlatformOrganizationProvisionRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      const currentTime = now();
      const organization = await store.createOrganization({
        id: randomUUID(),
        name: result.value.name,
        description: result.value.description,
        timezone: result.value.timezone,
        locale: result.value.locale,
        status: "active",
        createdAt: toIsoDate(currentTime),
        updatedAt: toIsoDate(currentTime),
      });

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.organizationProvision,
        actorUserId: null,
        authMethod: null,
        metadata: {
          platformActorUserId: authContext.user.id,
          status: organization.status,
        },
        objectId: organization.id,
        objectType: "organization",
        organizationId: organization.id,
      });

      return {
        status: 201,
        body: organizationResponse(organization),
      };
    },

    async createFirstAdministratorInvitation(organizationId, payload, authContext) {
      const authorization = requireRole(authContext, ["platform_operator"]);
      if (authorization) {
        return authorization;
      }

      const result = validateCreateOrganizationAdministratorRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      const organization = await store.findOrganizationById(organizationId);
      if (!organization) {
        return problem(404, "Not Found", "Organization was not found.");
      }

      if (organization.status !== "active") {
        return unauthorized("Organization is not active.");
      }

      const existingAdministrators = await store.countUsersByRole({
        organizationId,
        roleCode: "administrator",
      });
      const pendingAdministratorInvitations =
        await store.countPendingInvitationsByRole({
          now: toIsoDate(now()),
          organizationId,
          roleCode: "administrator",
        });

      if (existingAdministrators > 0 || pendingAdministratorInvitations > 0) {
        return problem(
          409,
          "Conflict",
          "Organization already has an Administrator or pending Administrator invitation.",
        );
      }

      return createInvitationRecord({
        authContext,
        createdBy: null,
        organizationId,
        platformActorUserId: authContext.user.id,
        value: result.value,
      });
    },

    async createInvitation(payload, authContext) {
      const authorization = requireRole(authContext, ["administrator"]);
      if (authorization) {
        return authorization;
      }

      const result = validateCreateInvitationRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      if (authContext.organization.id !== result.value.organizationId) {
        return forbidden("Administrator can create invitations only in their organization.");
      }

      return createInvitationRecord({
        authContext,
        createdBy: authContext.user.id,
        organizationId: result.value.organizationId,
        value: result.value,
      });
    },

    async acceptInvitation(payload, request = {}) {
      const result = validateAcceptInvitationRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      const currentTime = now();
      const tokenHash = hashInvitationToken(result.value.token);
      const invitation = await store.findInvitationByTokenHash(tokenHash);

      if (!invitation) {
        return unauthorized("Invitation token is invalid.");
      }

      if (invitation.acceptedAt) {
        return unauthorized("Invitation token has already been used.");
      }

      if (isOnOrBefore(invitation.expiresAt, currentTime)) {
        return unauthorized("Invitation token has expired.");
      }

      const consumedInvitation = await store.consumeInvitation(
        invitation.id,
        toIsoDate(currentTime),
      );

      if (!consumedInvitation) {
        return unauthorized("Invitation token has already been used.");
      }

      const displayName =
        result.value.displayName ??
        invitation.displayName ??
        invitation.contactValue;
      const userRecord = await store.createUserFromInvitation({
        displayName,
        id: randomUUID(),
        invitation,
      });

      if (!userRecord) {
        return problem(404, "Not Found", "Invitation organization was not found.");
      }

      const token = tokenGenerator();
      const expiresAt = addSeconds(currentTime, sessionTtlSeconds);
      const session = await store.createAuthSession({
        id: randomUUID(),
        tokenHash: hashSessionToken(token),
        user: userRecord.user,
        organization: userRecord.organization,
        roles: userRecord.roles,
        issuedAt: toIsoDate(currentTime),
        expiresAt: toIsoDate(expiresAt),
        revokedAt: null,
        ip: request.ip ?? null,
        userAgent: request.userAgent ?? null,
      });
      const authContext = toAuthContext(session);

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.invitationAccept,
        actorUserId: userRecord.user.id,
        authMethod: "invitation",
        metadata: {
          contactType: invitation.contactType,
          roleCode: invitation.roleCode,
        },
        objectId: invitation.id,
        objectType: "invitation",
        organizationId: invitation.organizationId,
        requestId: invitation.id,
      });
      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.loginSuccess,
        actorUserId: userRecord.user.id,
        authMethod: "invitation",
        ip: request.ip ?? null,
        metadata: {
          invitationId: invitation.id,
          roleCodes: [...userRecord.roles],
          sessionExpiresAt: session.expiresAt,
        },
        objectId: session.id,
        objectType: "auth_session",
        organizationId: invitation.organizationId,
        requestId: invitation.id,
      });

      return {
        status: 200,
        body: sessionResponse(authContext, token, "M4"),
        headers: {
          "set-cookie": `bridge_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionTtlSeconds}`,
        },
      };
    },

    async blockOrganization(organizationId, authContext) {
      const authorization = requireRole(authContext, ["platform_operator"]);
      if (authorization) {
        return authorization;
      }

      const before = await store.findOrganizationById(organizationId);
      if (!before) {
        return problem(404, "Not Found", "Organization was not found.");
      }

      const blocked = await store.updateOrganizationStatus(organizationId, {
        status: "blocked",
        updatedAt: toIsoDate(now()),
      });

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.organizationBlock,
        actorUserId: null,
        authMethod: null,
        metadata: {
          platformActorUserId: authContext.user.id,
          previousStatus: before.status,
          status: "blocked",
        },
        objectId: organizationId,
        objectType: "organization",
        organizationId,
      });

      return {
        status: 200,
        body: organizationResponse(blocked),
      };
    },

    async startTelegramLogin(payload) {
      const result = validateTelegramLoginStartRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      const rateLimit = startRateLimiter.hit(
        `telegram-start:${result.value.telegramUsername}`,
      );
      if (!rateLimit.allowed) {
        return tooManyRequests(
          "Too many Telegram login attempts. Try again later.",
          rateLimit.retryAfterSeconds,
        );
      }

      const userRecord = await store.findUserByTelegramUsername(
        result.value.telegramUsername,
      );

      if (!userRecord || userRecord.user.status !== "active") {
        if (userRecord) {
          await recordLoginFailure({
            failureResult: "denied",
            reason: "user_inactive_or_forbidden",
            userRecord,
          });
        }

        return unauthorized("Telegram user is not allowed to sign in.");
      }

      if (userRecord.organization.status !== "active") {
        await recordLoginFailure({
          failureResult: "denied",
          reason: "organization_inactive",
          userRecord,
        });

        return unauthorized("Organization is not active.");
      }

      if (!hasRoleBinding(userRecord)) {
        await recordLoginFailure({
          failureResult: "denied",
          reason: "role_binding_missing",
          userRecord,
        });

        return unauthorized("Telegram user has no active role binding.");
      }

      const code = codeGenerator();
      const createdAt = now();
      const expiresAt = addSeconds(createdAt, codeTtlSeconds);
      const loginCode = await store.createLoginCode({
        id: randomUUID(),
        userId: userRecord.user.id,
        organizationId: userRecord.user.organizationId,
        codeHash: hashLoginCode({
          userId: userRecord.user.id,
          code,
        }),
        purpose: TELEGRAM_LOGIN_PURPOSE,
        expiresAt: toIsoDate(expiresAt),
        consumedAt: null,
        createdAt: toIsoDate(createdAt),
        attemptCount: 0,
        lockedUntil: null,
      });

      await deliveryAdapter.deliverTelegramLoginCode({
        code,
        expiresAt: loginCode.expiresAt,
        purpose: TELEGRAM_LOGIN_PURPOSE,
        requestId: loginCode.id,
        telegramUsername: userRecord.user.telegramUsername,
        userId: userRecord.user.id,
      });

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.loginStart,
        actorUserId: userRecord.user.id,
        metadata: {
          deliveryChannel: "telegram",
          expiresAt: loginCode.expiresAt,
        },
        objectId: loginCode.id,
        objectType: "login_code",
        organizationId: userRecord.user.organizationId,
        requestId: loginCode.id,
      });

      return {
        status: 202,
        body: {
          status: "code_delivery_scheduled",
          delivery: "telegram",
          deliveryChannel: "telegram",
          telegramUsername: userRecord.user.telegramUsername,
          requestId: loginCode.id,
          expiresAt: loginCode.expiresAt,
          expiresInSeconds: codeTtlSeconds,
          implementationStage: "M1",
        },
      };
    },

    async verifyTelegramLogin(payload, request = {}) {
      const result = validateTelegramLoginVerifyRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      const rateLimit = verifyRateLimiter.hit(
        `telegram-verify:${result.value.requestId ?? result.value.telegramUsername}`,
      );
      if (!rateLimit.allowed) {
        return tooManyRequests(
          "Too many Telegram code verification attempts. Try again later.",
          rateLimit.retryAfterSeconds,
        );
      }

      const currentTime = now();
      let userRecord = null;
      let loginCode = null;

      if (result.value.requestId) {
        loginCode = await store.findLoginCodeById(result.value.requestId);
        if (loginCode) {
          userRecord = await findUserByLoginCode(loginCode);
        }
      } else {
        userRecord = await store.findUserByTelegramUsername(
          result.value.telegramUsername,
        );
        if (userRecord) {
          loginCode = await store.findLatestLoginCodeByUser({
            userId: userRecord.user.id,
            purpose: TELEGRAM_LOGIN_PURPOSE,
          });
        }
      }

      if (!userRecord || !loginCode) {
        return unauthorized("Telegram login code is invalid.");
      }

      if (userRecord.user.status !== "active") {
        await recordLoginFailure({
          failureResult: "denied",
          loginCode,
          reason: "user_inactive_or_forbidden",
          request,
          userRecord,
        });

        return unauthorized("Telegram user is not allowed to sign in.");
      }

      if (userRecord.organization.status !== "active") {
        await recordLoginFailure({
          failureResult: "denied",
          loginCode,
          reason: "organization_inactive",
          request,
          userRecord,
        });

        return unauthorized("Organization is not active.");
      }

      if (!hasRoleBinding(userRecord)) {
        await recordLoginFailure({
          failureResult: "denied",
          loginCode,
          reason: "role_binding_missing",
          request,
          userRecord,
        });

        return unauthorized("Telegram user has no active role binding.");
      }

      if (loginCode.lockedUntil && isAfter(loginCode.lockedUntil, currentTime)) {
        await recordLoginFailure({
          failureResult: "denied",
          loginCode,
          reason: "code_locked",
          request,
          userRecord,
        });

        return tooManyRequests(
          "Telegram login code is locked after too many attempts.",
          Math.ceil(
            (new Date(loginCode.lockedUntil).getTime() - currentTime.getTime()) /
              1000,
          ),
        );
      }

      if (loginCode.consumedAt) {
        await recordLoginFailure({
          loginCode,
          reason: "code_consumed",
          request,
          userRecord,
        });

        return unauthorized("Telegram login code has already been used.");
      }

      if (isOnOrBefore(loginCode.expiresAt, currentTime)) {
        await recordLoginFailure({
          loginCode,
          reason: "code_expired",
          request,
          userRecord,
        });

        return unauthorized("Telegram login code has expired.");
      }

      const expectedHash = hashLoginCode({
        userId: userRecord.user.id,
        code: result.value.code,
      });

      if (!secureEqual(expectedHash, loginCode.codeHash)) {
        const nextAttemptCount = loginCode.attemptCount + 1;
        const lockedUntil =
          nextAttemptCount >= maxVerifyAttempts
            ? toIsoDate(addSeconds(currentTime, lockoutSeconds))
            : null;

        await store.updateLoginCodeAttempts(loginCode.id, {
          attemptCount: nextAttemptCount,
          lockedUntil,
        });

        await recordLoginFailure({
          loginCode: {
            ...loginCode,
            attemptCount: nextAttemptCount,
            lockedUntil,
          },
          reason: lockedUntil ? "code_locked" : "code_invalid",
          request,
          userRecord,
        });

        if (lockedUntil) {
          return tooManyRequests(
            "Telegram login code is locked after too many attempts.",
            lockoutSeconds,
          );
        }

        return unauthorized("Telegram login code is invalid.");
      }

      const consumedCode = await store.consumeLoginCode(
        loginCode.id,
        toIsoDate(currentTime),
      );

      if (!consumedCode) {
        await recordLoginFailure({
          loginCode,
          reason: "code_consumed",
          request,
          userRecord,
        });

        return unauthorized("Telegram login code has already been used.");
      }

      const token = tokenGenerator();
      const issuedAt = currentTime;
      const expiresAt = addSeconds(issuedAt, sessionTtlSeconds);
      const session = await store.createAuthSession({
        id: randomUUID(),
        tokenHash: hashSessionToken(token),
        user: userRecord.user,
        organization: userRecord.organization,
        roles: userRecord.roles,
        issuedAt: toIsoDate(issuedAt),
        expiresAt: toIsoDate(expiresAt),
        revokedAt: null,
        ip: request.ip ?? null,
        userAgent: request.userAgent ?? null,
      });
      const authContext = toAuthContext(session);

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.loginSuccess,
        actorUserId: userRecord.user.id,
        ip: request.ip ?? null,
        metadata: {
          loginCodeId: loginCode.id,
          roleCodes: [...userRecord.roles],
          sessionExpiresAt: session.expiresAt,
        },
        objectId: session.id,
        objectType: "auth_session",
        organizationId: userRecord.user.organizationId,
        requestId: loginCode.id,
      });

      return {
        status: 200,
        body: sessionResponse(authContext, token),
        headers: {
          "set-cookie": `bridge_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionTtlSeconds}`,
        },
      };
    },

    async logout(authContext) {
      if (!authContext?.session?.id) {
        return unauthorized("Session is missing.");
      }

      const revokedAt = toIsoDate(now());
      await store.revokeSession(authContext.session.id, revokedAt);

      await recordAuditEvent({
        action: IDENTITY_AUDIT_ACTIONS.sessionLogout,
        actorUserId: authContext.user.id,
        metadata: {
          sessionRevokedAt: revokedAt,
        },
        objectId: authContext.session.id,
        objectType: "auth_session",
        organizationId: authContext.organization.id,
        result: "success",
      });

      return {
        status: 200,
        body: {
          loggedOut: true,
          sessionMode: "server",
          implementationStage: "M1",
        },
        headers: {
          "set-cookie":
            "bridge_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
        },
      };
    },

    async getSession(authContext) {
      if (!authContext?.session?.id) {
        return unauthorized("Session is missing.");
      }

      return {
        status: 200,
        body: sessionResponse(authContext, authContext.token),
      };
    },

    getSessionByToken,

    async authenticateToken(token) {
      const response = await getSessionByToken(token);

      if (response.status !== 200) {
        return {
          ok: false,
          response,
        };
      }

      return {
        ok: true,
        authContext: {
          ...response.body,
          token,
        },
      };
    },
  };

  async function findUserByLoginCode(loginCode) {
    const seededUser = await store.findUserByTelegramUsername(
      SEEDED_AUTH_CONTEXT.user.telegramUsername,
    );

    if (seededUser?.user.id === loginCode.userId) {
      return seededUser;
    }

    const latestBySeed = seededUser
      ? await store.findLatestLoginCodeByUser({
          userId: seededUser.user.id,
          purpose: TELEGRAM_LOGIN_PURPOSE,
        })
      : null;

    if (latestBySeed?.id === loginCode.id) {
      return seededUser;
    }

    return store.findUserById(loginCode.userId);
  }
}
