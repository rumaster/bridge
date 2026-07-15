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
  login_request_id: null | string;
  organization_id: string;
  purpose: string;
  user_id: string;
}

/** Пара «код + его пользователь» — по одной на каждую организацию аккаунта. */
interface LoginCandidate {
  loginCode: LoginCodeRow;
  user: TelegramUserRecord;
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
        // Один Telegram-аккаунт может быть администратором нескольких организаций,
        // поэтому кандидатов может быть несколько. Код выдаётся один на всех, а
        // строка login_codes — на каждого (хеш кода привязан к user_id).
        const users = await this.findUsersByTelegramUsername(client, telegramUsername);
        const eligible = users.filter(canSignIn);

        if (eligible.length === 0) {
          assertUserCanSignIn(users[0] ?? null);
        }

        const code = generateLoginCode();
        const loginRequestId = randomUUID();
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + CODE_TTL_SECONDS * 1000);

        for (const user of eligible) {
          const id = randomUUID();

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
                created_at,
                login_request_id
              )
              VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, 0, NULL, $7::timestamptz, $8)
            `,
            [
              id,
              user.userId,
              user.organizationId,
              hashLoginCode(user.userId, code),
              TELEGRAM_LOGIN_PURPOSE,
              expiresAt.toISOString(),
              createdAt.toISOString(),
              loginRequestId,
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
              organizationCandidates: eligible.length,
            },
            objectId: id,
            objectType: "login_code",
            organizationId: user.organizationId,
            requestId: loginRequestId,
          });
        }

        const [primary] = eligible;

        return {
          code,
          expiresAt: expiresAt.toISOString(),
          requestId: loginRequestId,
          telegramId: primary.telegramId,
          telegramUsername: primary.telegramUsername ?? telegramUsername,
          userId: primary.userId,
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

    // Locate the codes + users in a read-only transaction. Failure-path mutations below
    // run in their own committed transactions, because withTenant() rolls back on throw
    // and lockout/attempt bookkeeping must survive the rejected request.
    const candidates = await this.locateCandidates(payload.requestId, telegramUsername);
    if (candidates.length === 0) {
      throw invalidCode("Telegram login code is invalid.");
    }

    const now = new Date();
    // Коды группы выпущены одной транзакцией, поэтому срок, расход и блокировка у
    // них общие — достаточно проверить любой.
    const [{ loginCode }] = candidates;

    if (loginCode.locked_until && new Date(loginCode.locked_until).getTime() > now.getTime()) {
      await this.commitFailureAudit(candidates, "code_locked", meta);
      throw tooManyRequests(
        "Telegram login code is locked after too many attempts.",
        Math.ceil((new Date(loginCode.locked_until).getTime() - now.getTime()) / 1000),
      );
    }

    if (loginCode.consumed_at) {
      await this.commitFailureAudit(candidates, "code_consumed", meta);
      throw invalidCode("Telegram login code has already been used.");
    }

    if (new Date(loginCode.expires_at).getTime() <= now.getTime()) {
      await this.commitFailureAudit(candidates, "code_expired", meta);
      throw invalidCode("Telegram login code has expired.");
    }

    const matching = candidates.filter((candidate) =>
      secureEqual(
        hashLoginCode(candidate.user.userId, payload.code),
        candidate.loginCode.code_hash,
      ),
    );

    if (matching.length === 0) {
      const nextAttemptCount = loginCode.attempt_count + 1;
      const lockedUntil =
        nextAttemptCount >= MAX_VERIFY_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_SECONDS * 1000).toISOString()
          : null;

      await this.commitAttemptFailure(candidates, nextAttemptCount, lockedUntil, meta);

      if (lockedUntil) {
        throw tooManyRequests(
          "Telegram login code is locked after too many attempts.",
          LOCKOUT_SECONDS,
        );
      }

      throw invalidCode("Telegram login code is invalid.");
    }

    const eligible = matching.filter((candidate) => canSignIn(candidate.user));
    if (eligible.length === 0) {
      await this.commitFailureAudit(matching, "account_not_eligible", meta);
      assertUserCanSignIn(matching[0].user);
    }

    const selected = payload.organizationId
      ? eligible.find((candidate) => candidate.user.organizationId === payload.organizationId)
      : eligible.length === 1
        ? eligible[0]
        : undefined;

    if (!selected) {
      if (payload.organizationId) {
        throw invalidCode("Selected organization is not available for this login code.");
      }

      // Код верный, но организаций несколько: не расходуем его и просим выбрать.
      throw organizationSelectionRequired(eligible);
    }

    // Success: consume the code and create the session atomically.
    return this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        // Расходуется вся группа: один выданный код — одна сессия, даже если
        // организаций у аккаунта несколько.
        const consumed = await client.query<{ id: string }>(
          `
            UPDATE login_codes
            SET consumed_at = $2::timestamptz
            WHERE id = ANY($1::uuid[]) AND consumed_at IS NULL
            RETURNING id
          `,
          [candidates.map((candidate) => candidate.loginCode.id), now.toISOString()],
        );
        if (!consumed.rows.some((row) => row.id === selected.loginCode.id)) {
          throw invalidCode("Telegram login code has already been used.");
        }

        const session = await this.createSessionForUser(client, selected.user, meta);

        await this.audit.record(client, {
          action: AUDIT_ACTIONS.loginSuccess,
          actorUserId: selected.user.userId,
          ip: meta.ip ?? null,
          metadata: {
            authMethod: "telegram",
            loginCodeId: selected.loginCode.id,
            organizationCandidates: eligible.length,
            roleCodes: selected.user.roleCodes,
            sessionExpiresAt: session.expiresAt,
          },
          objectId: session.id,
          objectType: "auth_session",
          organizationId: selected.user.organizationId,
          requestId: selected.loginCode.login_request_id ?? selected.loginCode.id,
        });

        return buildSessionResponse(selected.user, session);
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

  /**
   * Находит все коды, выданные одним запросом, вместе с их пользователями. При
   * поиске по requestId группа определяется по login_request_id, при поиске по
   * @username — берётся последняя группа среди кодов пользователя.
   */
  private async locateCandidates(
    requestId: string | undefined,
    telegramUsername: string | undefined,
  ): Promise<LoginCandidate[]> {
    return this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        let loginCodes: LoginCodeRow[] = [];

        if (requestId) {
          loginCodes = await this.findLoginCodesByRequestId(client, requestId);
        } else if (telegramUsername) {
          loginCodes = await this.findLatestLoginCodesByUsername(client, telegramUsername);
        }

        const candidates: LoginCandidate[] = [];

        for (const loginCode of loginCodes) {
          const user = await this.findUserById(
            client,
            loginCode.user_id,
            loginCode.organization_id,
          );

          if (user) {
            candidates.push({ loginCode, user });
          }
        }

        return candidates;
      },
      { isPlatformOperator: true },
    );
  }

  private async commitAttemptFailure(
    candidates: LoginCandidate[],
    nextAttemptCount: number,
    lockedUntil: string | null,
    meta: TelegramLoginRequestMeta,
  ): Promise<void> {
    await this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        await client.query(
          "UPDATE login_codes SET attempt_count = $2, locked_until = $3::timestamptz WHERE id = ANY($1::uuid[])",
          [candidates.map((candidate) => candidate.loginCode.id), nextAttemptCount, lockedUntil],
        );

        for (const candidate of candidates) {
          await this.recordFailure(
            client,
            candidate.user,
            candidate.loginCode.id,
            lockedUntil ? "code_locked" : "code_invalid",
            meta,
          );
        }
      },
      { isPlatformOperator: true },
    );
  }

  private async commitFailureAudit(
    candidates: LoginCandidate[],
    reason: string,
    meta: TelegramLoginRequestMeta,
  ): Promise<void> {
    await this.database.withTenant(
      LOOKUP_ORGANIZATION_ID,
      async (client) => {
        for (const candidate of candidates) {
          await this.recordFailure(client, candidate.user, candidate.loginCode.id, reason, meta);
        }
      },
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

  private async findUsersByTelegramUsername(
    client: Queryable,
    telegramUsername: string,
  ): Promise<TelegramUserRecord[]> {
    const result = await client.query<UserJoinRow>(
      `${userSelectSql} WHERE lower(u.telegram_username) = $1 GROUP BY u.id, o.id ORDER BY o.created_at`,
      [telegramUsername],
    );

    return result.rows.map(mapUserRecord);
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

  /**
   * Коды одной группы. Строки, выпущенные до появления login_request_id, группы
   * не имеют, поэтому такой requestId трактуется как id самой строки.
   */
  private async findLoginCodesByRequestId(
    client: Queryable,
    requestId: string,
  ): Promise<LoginCodeRow[]> {
    const result = await client.query<LoginCodeRow>(
      `
        SELECT ${LOGIN_CODE_COLUMNS}
        FROM login_codes
        WHERE purpose = $2 AND (login_request_id = $1 OR (login_request_id IS NULL AND id = $1))
      `,
      [requestId, TELEGRAM_LOGIN_PURPOSE],
    );

    return result.rows;
  }

  /** Последняя выданная группа кодов для @username по всем его организациям. */
  private async findLatestLoginCodesByUsername(
    client: Queryable,
    telegramUsername: string,
  ): Promise<LoginCodeRow[]> {
    const result = await client.query<LoginCodeRow>(
      `
        WITH candidate_codes AS (
          SELECT lc.*
          FROM login_codes lc
          JOIN users u ON u.id = lc.user_id AND u.organization_id = lc.organization_id
          WHERE lower(u.telegram_username) = $1 AND lc.purpose = $2
        ),
        latest AS (
          SELECT login_request_id, id, created_at
          FROM candidate_codes
          ORDER BY created_at DESC
          LIMIT 1
        )
        SELECT c.*
        FROM candidate_codes c, latest l
        WHERE (l.login_request_id IS NOT NULL AND c.login_request_id = l.login_request_id)
           OR (l.login_request_id IS NULL AND c.id = l.id)
      `,
      [telegramUsername, TELEGRAM_LOGIN_PURPOSE],
    );

    return result.rows;
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
  "id, user_id, organization_id, code_hash, purpose, expires_at, consumed_at, attempt_count, locked_until, login_request_id";

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

function canSignIn(user: TelegramUserRecord): boolean {
  return (
    user.userStatus === "active" &&
    user.organizationStatus === "active" &&
    user.roleCodes.length > 0
  );
}

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

/**
 * Код верен, но аккаунт администрирует несколько организаций. Клиент повторяет
 * verify с organizationId из списка; код при этом не расходуется.
 */
function organizationSelectionRequired(candidates: LoginCandidate[]): HttpException {
  return new HttpException(
    {
      code: "ORGANIZATION_SELECTION_REQUIRED",
      description: "Telegram account administers several organizations; choose one.",
      // Только diagnostics переживает ApiExceptionFilter: остальные поля тела
      // исключения он отбрасывает, оставляя code/description/humanMessage.
      diagnostics: {
        organizations: candidates.map((candidate) => ({
          id: candidate.user.organizationId,
          name: candidate.user.organizationName,
          role: primaryRole(candidate.user.roleCodes),
        })),
      },
      humanMessage: "Выберите организацию для входа.",
    },
    HttpStatus.CONFLICT,
  );
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
