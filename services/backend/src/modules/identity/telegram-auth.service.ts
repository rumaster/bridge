import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";

import {
  AUTH_HASH_SECRET_ENV,
  AuthSessionContext,
  DEFAULT_AUTH_HASH_SECRET,
  RoleCode,
  isRoleCode,
  primaryRole,
} from "../../common/auth/auth-context";
import { hashSessionToken } from "../../common/auth/session-auth.guard";
import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import {
  TelegramLoginStartDto,
  TelegramLoginStartResponseDto,
  TelegramLoginVerifyDto,
  normalizeTelegramUsername,
} from "./telegram-auth.dto";
import {
  TelegramLoginRateLimiter,
  readPositiveIntegerEnv,
  requireTelegramLoginRateLimit,
} from "./telegram-login-rate-limiter";
import { TelegramCodeDeliveryService } from "./telegram-bot.service";

const TELEGRAM_LOGIN_PURPOSE = "telegram_login";
const LOOKUP_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";
const CODE_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOCKOUT_SECONDS = 15 * 60;
const MAX_VERIFY_ATTEMPTS = 5;
const IMPLEMENTATION_STAGE = "M1";
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

const AUDIT_ACTIONS = {
  loginFailure: "auth.login.failure",
  loginStart: "auth.login.start",
  loginSuccess: "auth.login.success",
} as const;

interface TelegramUserRecord {
  displayName: string;
  email: null | string;
  organizationId: string;
  organizationName: string;
  organizationStatus: string;
  roleCodes: RoleCode[];
  telegramId: null | string;
  telegramUsername: null | string;
  userId: string;
  userStatus: string;
}

interface LoginCodeRow {
  attempt_count: number;
  code_hash: string;
  consumed_at: Date | string | null;
  expires_at: Date | string;
  id: string;
  locked_until: Date | string | null;
  organization_id: string;
  purpose: string;
  user_id: string;
}

interface CreatedSession {
  expiresAt: string;
  id: string;
  issuedAt: string;
  token: string;
}

export interface TelegramLoginRequestMeta {
  ip?: null | string;
  userAgent?: null | string;
}

@Injectable()
export class TelegramAuthService {
  private readonly startRateLimiter = new TelegramLoginRateLimiter({
    limit: readPositiveIntegerEnv("TELEGRAM_LOGIN_START_RATE_LIMIT", DEFAULT_RATE_LIMIT),
    windowSeconds: readPositiveIntegerEnv(
      "TELEGRAM_LOGIN_RATE_LIMIT_WINDOW_SECONDS",
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    ),
  });

  private readonly verifyRateLimiter = new TelegramLoginRateLimiter({
    limit: readPositiveIntegerEnv("TELEGRAM_LOGIN_VERIFY_RATE_LIMIT", DEFAULT_RATE_LIMIT),
    windowSeconds: readPositiveIntegerEnv(
      "TELEGRAM_LOGIN_RATE_LIMIT_WINDOW_SECONDS",
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    ),
  });

  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly telegram: TelegramCodeDeliveryService,
  ) {}

  async startLogin(
    payload: TelegramLoginStartDto,
    meta: TelegramLoginRequestMeta = {},
  ): Promise<TelegramLoginStartResponseDto> {
    const telegramUsername = normalizeTelegramUsername(payload.telegramUsername);
    this.assertStartRateLimit(telegramUsername, meta);

    const prepared = await this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        const user = await this.findUserByTelegramUsername(client, telegramUsername);
        assertUserCanSignIn(user);

        const code = generateLoginCode();
        const id = randomUUID();
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + CODE_TTL_SECONDS * 1000);

        await client.query(
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
            VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, 0, NULL, $7::timestamptz)
          `,
          [
            id,
            user.userId,
            user.organizationId,
            hashLoginCode(user.userId, code),
            TELEGRAM_LOGIN_PURPOSE,
            expiresAt.toISOString(),
            createdAt.toISOString(),
          ],
        );

        await this.audit.record(client, {
          action: AUDIT_ACTIONS.loginStart,
          actorUserId: user.userId,
          ip: meta.ip ?? null,
          metadata: {
            authMethod: "telegram",
            deliveryChannel: "telegram",
            expiresAt: expiresAt.toISOString(),
          },
          objectId: id,
          objectType: "login_code",
          organizationId: user.organizationId,
          requestId: id,
        });

        return {
          code,
          expiresAt: expiresAt.toISOString(),
          requestId: id,
          telegramId: user.telegramId,
          telegramUsername: user.telegramUsername ?? telegramUsername,
          userId: user.userId,
        };
      },
      { isPlatformOperator: true },
    );

    const delivery = await this.telegram.deliver({
      code: prepared.code,
      expiresAt: prepared.expiresAt,
      purpose: TELEGRAM_LOGIN_PURPOSE,
      requestId: prepared.requestId,
      telegramId: prepared.telegramId,
      telegramUsername: prepared.telegramUsername,
      userId: prepared.userId,
    });

    return {
      delivery: "telegram",
      deliveryChannel: "telegram",
      expiresAt: prepared.expiresAt,
      expiresInSeconds: CODE_TTL_SECONDS,
      implementationStage: IMPLEMENTATION_STAGE,
      note: delivery.note ?? null,
      requestId: prepared.requestId,
      status: "code_delivery_scheduled",
      telegramUsername: prepared.telegramUsername,
    };
  }

  async verifyLogin(
    payload: TelegramLoginVerifyDto,
    meta: TelegramLoginRequestMeta = {},
  ): Promise<Record<string, unknown>> {
    const telegramUsername = payload.telegramUsername
      ? normalizeTelegramUsername(payload.telegramUsername)
      : undefined;

    if (!payload.requestId && !telegramUsername) {
      throw invalidCode("Telegram login code is invalid.");
    }
    this.assertVerifyRateLimit(payload.requestId, telegramUsername, meta);

    // Locate the code + user in a read-only transaction. Failure-path mutations below
    // run in their own committed transactions, because withTenant() rolls back on throw
    // and lockout/attempt bookkeeping must survive the rejected request.
    const located = await this.locateLoginCode(payload.requestId, telegramUsername);
    if (!located) {
      throw invalidCode("Telegram login code is invalid.");
    }

    const { loginCode, user } = located;
    const now = new Date();

    if (
      user.userStatus !== "active" ||
      user.organizationStatus !== "active" ||
      user.roleCodes.length === 0
    ) {
      await this.commitFailureAudit(user, loginCode.id, "account_not_eligible", meta);
      assertUserCanSignIn(user);
    }

    if (loginCode.locked_until && new Date(loginCode.locked_until).getTime() > now.getTime()) {
      await this.commitFailureAudit(user, loginCode.id, "code_locked", meta);
      throw tooManyRequests(
        "Telegram login code is locked after too many attempts.",
        Math.ceil((new Date(loginCode.locked_until).getTime() - now.getTime()) / 1000),
      );
    }

    if (loginCode.consumed_at) {
      await this.commitFailureAudit(user, loginCode.id, "code_consumed", meta);
      throw invalidCode("Telegram login code has already been used.");
    }

    if (new Date(loginCode.expires_at).getTime() <= now.getTime()) {
      await this.commitFailureAudit(user, loginCode.id, "code_expired", meta);
      throw invalidCode("Telegram login code has expired.");
    }

    const expectedHash = hashLoginCode(user.userId, payload.code);
    if (!secureEqual(expectedHash, loginCode.code_hash)) {
      const nextAttemptCount = loginCode.attempt_count + 1;
      const lockedUntil =
        nextAttemptCount >= MAX_VERIFY_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_SECONDS * 1000).toISOString()
          : null;

      await this.commitAttemptFailure(user, loginCode.id, nextAttemptCount, lockedUntil, meta);

      if (lockedUntil) {
        throw tooManyRequests(
          "Telegram login code is locked after too many attempts.",
          LOCKOUT_SECONDS,
        );
      }

      throw invalidCode("Telegram login code is invalid.");
    }

    // Success: consume the code and create the session atomically.
    return this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        const consumed = await client.query(
          "UPDATE login_codes SET consumed_at = $2::timestamptz WHERE id = $1 AND consumed_at IS NULL RETURNING id",
          [loginCode.id, now.toISOString()],
        );
        if (consumed.rowCount === 0) {
          throw invalidCode("Telegram login code has already been used.");
        }

        const session = await this.createSessionForUser(client, user, meta);

        await this.audit.record(client, {
          action: AUDIT_ACTIONS.loginSuccess,
          actorUserId: user.userId,
          ip: meta.ip ?? null,
          metadata: {
            authMethod: "telegram",
            loginCodeId: loginCode.id,
            roleCodes: user.roleCodes,
            sessionExpiresAt: session.expiresAt,
          },
          objectId: session.id,
          objectType: "auth_session",
          organizationId: user.organizationId,
          requestId: loginCode.id,
        });

        return buildSessionResponse(user, session);
      },
      { isPlatformOperator: true },
    );
  }

  getSession(auth: AuthSessionContext): AuthSessionContext {
    return auth;
  }

  private assertStartRateLimit(
    telegramUsername: string,
    meta: TelegramLoginRequestMeta,
  ): void {
    const decision = requireTelegramLoginRateLimit(this.startRateLimiter, [
      `telegram-login:start:user:${telegramUsername}`,
      meta.ip ? `telegram-login:start:ip:${meta.ip}` : "",
    ]);

    if (!decision.allowed) {
      throw tooManyRequests(
        "Too many Telegram login attempts. Try again later.",
        decision.retryAfterSeconds,
      );
    }
  }

  private assertVerifyRateLimit(
    requestId: string | undefined,
    telegramUsername: string | undefined,
    meta: TelegramLoginRequestMeta,
  ): void {
    const decision = requireTelegramLoginRateLimit(this.verifyRateLimiter, [
      requestId ? `telegram-login:verify:request:${requestId}` : "",
      telegramUsername ? `telegram-login:verify:user:${telegramUsername}` : "",
      meta.ip ? `telegram-login:verify:ip:${meta.ip}` : "",
    ]);

    if (!decision.allowed) {
      throw tooManyRequests(
        "Too many Telegram code verification attempts. Try again later.",
        decision.retryAfterSeconds,
      );
    }
  }

  private async locateLoginCode(
    requestId: string | undefined,
    telegramUsername: string | undefined,
  ): Promise<{ loginCode: LoginCodeRow; user: TelegramUserRecord } | null> {
    return this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        let loginCode: LoginCodeRow | null = null;

        if (requestId) {
          loginCode = await this.findLoginCodeById(client, requestId);
        } else if (telegramUsername) {
          const user = await this.findUserByTelegramUsername(client, telegramUsername);
          if (user) {
            loginCode = await this.findLatestLoginCodeByUser(client, user.userId);
          }
        }

        if (!loginCode) {
          return null;
        }

        const user = await this.findUserById(
          client,
          loginCode.user_id,
          loginCode.organization_id,
        );

        return user ? { loginCode, user } : null;
      },
      { isPlatformOperator: true },
    );
  }

  private async commitAttemptFailure(
    user: TelegramUserRecord,
    loginCodeId: string,
    nextAttemptCount: number,
    lockedUntil: string | null,
    meta: TelegramLoginRequestMeta,
  ): Promise<void> {
    await this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        await client.query(
          "UPDATE login_codes SET attempt_count = $2, locked_until = $3::timestamptz WHERE id = $1",
          [loginCodeId, nextAttemptCount, lockedUntil],
        );
        await this.recordFailure(
          client,
          user,
          loginCodeId,
          lockedUntil ? "code_locked" : "code_invalid",
          meta,
        );
      },
      { isPlatformOperator: true },
    );
  }

  private async commitFailureAudit(
    user: TelegramUserRecord,
    loginCodeId: string,
    reason: string,
    meta: TelegramLoginRequestMeta,
  ): Promise<void> {
    await this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      (client) => this.recordFailure(client, user, loginCodeId, reason, meta),
      { isPlatformOperator: true },
    );
  }

  private async recordFailure(
    client: Queryable,
    user: TelegramUserRecord,
    loginCodeId: string,
    reason: string,
    meta: TelegramLoginRequestMeta,
  ): Promise<void> {
    await this.audit.record(client, {
      action: AUDIT_ACTIONS.loginFailure,
      actorUserId: user.userId,
      ip: meta.ip ?? null,
      metadata: { authMethod: "telegram", reason },
      objectId: loginCodeId,
      objectType: "login_code",
      organizationId: user.organizationId,
      requestId: loginCodeId,
      result: "failure",
    });
  }

  private async createSessionForUser(
    client: Queryable,
    user: TelegramUserRecord,
    meta: TelegramLoginRequestMeta,
  ): Promise<CreatedSession> {
    const id = randomUUID();
    const token = createSessionToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000);

    await client.query(
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
        VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, NULL, $7::inet, $8)
      `,
      [
        id,
        user.userId,
        user.organizationId,
        hashSessionToken(token),
        issuedAt.toISOString(),
        expiresAt.toISOString(),
        meta.ip ?? null,
        meta.userAgent ?? null,
      ],
    );

    return {
      expiresAt: expiresAt.toISOString(),
      id,
      issuedAt: issuedAt.toISOString(),
      token,
    };
  }

  private async findUserByTelegramUsername(
    client: Queryable,
    telegramUsername: string,
  ): Promise<TelegramUserRecord | null> {
    const result = await client.query<UserJoinRow>(
      `${userSelectSql} WHERE lower(u.telegram_username) = $1 GROUP BY u.id, o.id LIMIT 1`,
      [telegramUsername],
    );

    return result.rowCount === 0 ? null : mapUserRecord(result.rows[0]);
  }

  private async findUserById(
    client: Queryable,
    userId: string,
    organizationId: string,
  ): Promise<TelegramUserRecord | null> {
    const result = await client.query<UserJoinRow>(
      `${userSelectSql} WHERE u.id = $1 AND u.organization_id = $2 GROUP BY u.id, o.id LIMIT 1`,
      [userId, organizationId],
    );

    return result.rowCount === 0 ? null : mapUserRecord(result.rows[0]);
  }

  private async findLoginCodeById(
    client: Queryable,
    id: string,
  ): Promise<LoginCodeRow | null> {
    const result = await client.query<LoginCodeRow>(
      `SELECT ${LOGIN_CODE_COLUMNS} FROM login_codes WHERE id = $1 AND purpose = $2 LIMIT 1`,
      [id, TELEGRAM_LOGIN_PURPOSE],
    );

    return result.rowCount === 0 ? null : result.rows[0];
  }

  private async findLatestLoginCodeByUser(
    client: Queryable,
    userId: string,
  ): Promise<LoginCodeRow | null> {
    const result = await client.query<LoginCodeRow>(
      `
        SELECT ${LOGIN_CODE_COLUMNS}
        FROM login_codes
        WHERE user_id = $1 AND purpose = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [userId, TELEGRAM_LOGIN_PURPOSE],
    );

    return result.rowCount === 0 ? null : result.rows[0];
  }
}

interface UserJoinRow {
  display_name: string;
  email: null | string;
  organization_id: string;
  organization_name: string;
  organization_status: string;
  role_codes: string[];
  telegram_id: null | string;
  telegram_username: null | string;
  user_id: string;
  user_status: string;
}

const LOGIN_CODE_COLUMNS =
  "id, user_id, organization_id, code_hash, purpose, expires_at, consumed_at, attempt_count, locked_until";

const userSelectSql = `
  SELECT
    u.id AS user_id,
    u.organization_id,
    u.telegram_username,
    u.telegram_id,
    u.email,
    u.display_name,
    u.status AS user_status,
    o.name AS organization_name,
    o.status AS organization_status,
    COALESCE(
      array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL),
      '{}'::text[]
    ) AS role_codes
  FROM users u
  JOIN organizations o ON o.id = u.organization_id
  LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.organization_id = u.organization_id
  LEFT JOIN roles r ON r.id = ur.role_id
`;

function assertUserCanSignIn(
  user: TelegramUserRecord | null,
): asserts user is TelegramUserRecord {
  if (!user || user.userStatus !== "active") {
    throw forbiddenLogin("Telegram user is not allowed to sign in.");
  }

  if (user.organizationStatus !== "active") {
    throw new UnauthorizedException({
      code: "ORGANIZATION_INACTIVE",
      description: "Organization is not active.",
      humanMessage: "Организация не активна.",
    });
  }

  if (user.roleCodes.length === 0) {
    throw new UnauthorizedException({
      code: "ROLE_BINDING_REQUIRED",
      description: "Telegram user has no active role binding.",
      humanMessage: "У пользователя нет активной роли.",
    });
  }
}

function mapUserRecord(row: UserJoinRow): TelegramUserRecord {
  return {
    displayName: row.display_name,
    email: row.email,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationStatus: row.organization_status,
    roleCodes: [...new Set((row.role_codes ?? []).filter(isRoleCode))],
    telegramId: row.telegram_id,
    telegramUsername: row.telegram_username,
    userId: row.user_id,
    userStatus: row.user_status,
  };
}

function buildSessionResponse(
  user: TelegramUserRecord,
  session: CreatedSession,
): Record<string, unknown> {
  const roles = user.roleCodes;

  return {
    authenticated: true,
    expiresAt: session.expiresAt,
    implementationStage: IMPLEMENTATION_STAGE,
    organization: {
      id: user.organizationId,
      name: user.organizationName,
      slug: slugify(user.organizationName),
      status: user.organizationStatus,
    },
    roleBindings: roles.map((role) => ({
      organizationId: user.organizationId,
      role,
    })),
    roles,
    session: {
      expiresAt: session.expiresAt,
      id: session.id,
      issuedAt: session.issuedAt,
      mode: "server",
      revokedAt: null,
    },
    token: session.token,
    user: {
      displayName: user.displayName,
      email: user.email,
      id: user.userId,
      organizationId: user.organizationId,
      role: primaryRole(roles),
      status: user.userStatus,
      telegramUsername: user.telegramUsername,
    },
  };
}

function generateLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function createSessionToken(): string {
  return `brs_${randomBytes(32).toString("base64url")}`;
}

function hashLoginCode(userId: string, code: string): string {
  const secret = process.env[AUTH_HASH_SECRET_ENV] ?? DEFAULT_AUTH_HASH_SECRET;

  return `sha256:${createHmac("sha256", secret)
    .update(`${TELEGRAM_LOGIN_PURPOSE}:${userId}:${code}`)
    .digest("hex")}`;
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function forbiddenLogin(description: string): UnauthorizedException {
  return new UnauthorizedException({
    code: "TELEGRAM_LOGIN_FORBIDDEN",
    description,
    humanMessage: "Вход через Telegram недоступен для этого пользователя.",
  });
}

function invalidCode(description: string): UnauthorizedException {
  return new UnauthorizedException({
    code: "TELEGRAM_LOGIN_INVALID",
    description,
    humanMessage: "Код входа через Telegram недействителен.",
  });
}

function tooManyRequests(description: string, retryAfterSeconds: number): HttpException {
  return new HttpException(
    {
      code: "TOO_MANY_REQUESTS",
      description,
      diagnostics: { retryAfterSeconds },
      humanMessage: "Слишком много попыток. Повторите позже.",
      retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
