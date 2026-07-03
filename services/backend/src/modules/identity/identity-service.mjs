import {
  randomBytes,
  randomInt,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { SEEDED_AUTH_CONTEXT } from "../../common/auth/mock-auth-guard.mjs";
import {
  validateTelegramLoginStartRequest,
  validateTelegramLoginVerifyRequest,
} from "./dto/auth-dto.mjs";

const TELEGRAM_LOGIN_PURPOSE = "telegram_login";
const DEFAULT_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_HASH_SECRET = "bridge-local-dev-auth-secret";

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

function hasRoleBinding(record) {
  return Array.isArray(record?.roles) && record.roles.length > 0;
}

function sessionResponse(authContext, token) {
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
    implementationStage: "M1",
  };
}

function seededUserRecord() {
  return {
    user: {
      id: SEEDED_AUTH_CONTEXT.user.id,
      organizationId: SEEDED_AUTH_CONTEXT.user.organizationId,
      telegramUsername: SEEDED_AUTH_CONTEXT.user.telegramUsername,
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

export function createInMemoryIdentityStore({
  users = [seededUserRecord()],
} = {}) {
  const usersByTelegram = new Map();
  const loginCodes = new Map();
  const sessions = new Map();

  for (const userRecord of users) {
    usersByTelegram.set(
      userRecord.user.telegramUsername.toLowerCase(),
      structuredClone(userRecord),
    );
  }

  return {
    async findUserByTelegramUsername(telegramUsername) {
      return cloneOrNull(usersByTelegram.get(telegramUsername.toLowerCase()));
    },

    async findUserById(userId) {
      return cloneOrNull(
        [...usersByTelegram.values()].find(
          (record) => record.user.id === userId,
        ),
      );
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
  };
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
  };
}

function mapUserRow(row) {
  return {
    user: {
      id: row.id,
      organizationId: row.organization_id,
      telegramUsername: row.telegram_username,
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

export function createIdentityService({
  codeGenerator = createDefaultCode,
  codeTtlSeconds = DEFAULT_CODE_TTL_SECONDS,
  deliveryAdapter = createMockTelegramCodeDeliveryAdapter(),
  hashSecret = process.env.BRIDGE_AUTH_SECRET ?? DEFAULT_HASH_SECRET,
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

  return {
    hashLoginCode,
    hashSessionToken,

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
        return unauthorized("Telegram user is not allowed to sign in.");
      }

      if (userRecord.organization.status !== "active") {
        return unauthorized("Organization is not active.");
      }

      if (!hasRoleBinding(userRecord)) {
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
        return unauthorized("Telegram user is not allowed to sign in.");
      }

      if (userRecord.organization.status !== "active") {
        return unauthorized("Organization is not active.");
      }

      if (!hasRoleBinding(userRecord)) {
        return unauthorized("Telegram user has no active role binding.");
      }

      if (loginCode.lockedUntil && isAfter(loginCode.lockedUntil, currentTime)) {
        return tooManyRequests(
          "Telegram login code is locked after too many attempts.",
          Math.ceil(
            (new Date(loginCode.lockedUntil).getTime() - currentTime.getTime()) /
              1000,
          ),
        );
      }

      if (loginCode.consumedAt) {
        return unauthorized("Telegram login code has already been used.");
      }

      if (isOnOrBefore(loginCode.expiresAt, currentTime)) {
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

      await store.revokeSession(authContext.session.id, toIsoDate(now()));

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
