import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";

import {
  AUTH_HASH_SECRET_ENV,
  DEFAULT_AUTH_HASH_SECRET,
  primaryRole,
} from "../../common/auth/auth-context";
import { hashSessionToken } from "../../common/auth/session-auth.guard";
import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import {
  RegistrationStartDto,
  RegistrationStartResponseDto,
  RegistrationStatus,
  RegistrationStatusResponseDto,
  RegistrationVerifyDto,
  normalizeRegistrationEmail,
  normalizeRegistrationUsername,
} from "./registration.dto";
import {
  TelegramLoginRateLimiter,
  readPositiveIntegerEnv,
  requireTelegramLoginRateLimit,
} from "./telegram-login-rate-limiter";
import { TelegramCodeDeliveryService } from "./telegram-bot.service";

const PLATFORM_LOOKUP_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";
const REGISTRATION_PURPOSE = "registration";
/** Незавершённая заявка живёт сутки, после чего удаляется (organization не создаётся вовсе). */
const REQUEST_TTL_SECONDS = 24 * 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOCKOUT_SECONDS = 15 * 60;
const MAX_VERIFY_ATTEMPTS = 5;
const IMPLEMENTATION_STAGE = "M1";
const DEFAULT_RATE_LIMIT = 5;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Аудитируется только успешная регистрация: audit_events.organization_id — NOT
 * NULL с FK на organizations, а до подтверждения кода организации не существует.
 * След анонимных попыток остаётся в самой registration_requests (ip,
 * attempt_count, locked_until) и в логах.
 */
const AUDIT_ACTIONS = {
  registerSuccess: "auth.register.success",
} as const;

export interface RegistrationRequestMeta {
  ip?: null | string;
  userAgent?: null | string;
}

/** Отправитель апдейта /start, из которого узнаём числовой chat_id. */
export interface TelegramStartActor {
  firstName?: null | string;
  id: number;
  lastName?: null | string;
  username?: null | string;
}

interface RegistrationRow {
  attempt_count: number;
  code_expires_at: Date | string | null;
  code_hash: null | string;
  delivery_note: null | string;
  display_name: null | string;
  email: string;
  expires_at: Date | string;
  id: string;
  locked_until: Date | string | null;
  organization_name: string;
  status: RegistrationStatus;
  telegram_id: null | string;
  telegram_username: string;
}

interface CreatedUserRecord {
  displayName: string;
  email: string;
  id: string;
  organizationId: string;
  organizationName: string;
  organizationStatus: string;
  telegramUsername: string;
}

/**
 * Самостоятельная регистрация администратора новой организации.
 *
 * Организация в БД не создаётся до подтверждения кода: заявка живёт в
 * `registration_requests` и удаляется через сутки, если её не завершили.
 *
 * Ключевое ограничение (то же, что и в регрессе #187): Telegram Bot API не умеет
 * писать приватному пользователю по @username, поэтому код нельзя отправить
 * сразу после отправки формы. Пользователь обязан открыть deep-link
 * `t.me/<bot>?start=<token>` и нажать Start — только из этого апдейта бот узнаёт
 * числовой chat_id. Апдейт ловит TelegramUpdatesPoller и зовёт
 * {@link RegistrationService.handleStartCommand}.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  private readonly startRateLimiter = new TelegramLoginRateLimiter({
    limit: readPositiveIntegerEnv("REGISTRATION_START_RATE_LIMIT", DEFAULT_RATE_LIMIT),
    windowSeconds: readPositiveIntegerEnv(
      "REGISTRATION_RATE_LIMIT_WINDOW_SECONDS",
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    ),
  });

  private readonly verifyRateLimiter = new TelegramLoginRateLimiter({
    limit: readPositiveIntegerEnv("REGISTRATION_VERIFY_RATE_LIMIT", DEFAULT_RATE_LIMIT),
    windowSeconds: readPositiveIntegerEnv(
      "REGISTRATION_RATE_LIMIT_WINDOW_SECONDS",
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    ),
  });

  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly telegram: TelegramCodeDeliveryService,
  ) {}

  async startRegistration(
    payload: RegistrationStartDto,
    meta: RegistrationRequestMeta = {},
  ): Promise<RegistrationStartResponseDto> {
    const telegramUsername = normalizeRegistrationUsername(payload.telegramUsername);
    const email = normalizeRegistrationEmail(payload.email);
    const organizationName = payload.organizationName.trim();

    this.assertRateLimit(this.startRateLimiter, [
      `registration:start:user:${telegramUsername}`,
      meta.ip ? `registration:start:ip:${meta.ip}` : "",
    ]);

    const startToken = createStartToken();
    const prepared = await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      async (client) => {
        await this.purgeExpired(client);

        const id = randomUUID();
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + REQUEST_TTL_SECONDS * 1000);

        await client.query(
          `
            INSERT INTO registration_requests (
              id,
              telegram_username,
              email,
              organization_name,
              start_token_hash,
              status,
              expires_at,
              ip,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, 'pending', $6::timestamptz, $7::inet, $8::timestamptz, $8::timestamptz)
          `,
          [
            id,
            telegramUsername,
            email,
            organizationName,
            hashStartToken(startToken),
            expiresAt.toISOString(),
            meta.ip ?? null,
            createdAt.toISOString(),
          ],
        );

        return { expiresAt: expiresAt.toISOString(), id };
      },
      { isPlatformOperator: true },
    );

    const botUsername = await this.telegram.getBotUsername();

    return {
      botUsername,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${startToken}` : null,
      expiresAt: prepared.expiresAt,
      note: botUsername ? null : "telegram_bot_not_configured",
      requestId: prepared.id,
      status: "pending",
    };
  }

  /**
   * Обрабатывает `/start <token>` от бота: связывает заявку с числовым chat_id
   * отправителя и отправляет код подтверждения.
   *
   * Совпадение @username отправителя с заявленным при регистрации обязательно —
   * именно оно доказывает владение Telegram-аккаунтом, на который выписывается
   * администратор организации.
   */
  async handleStartCommand(startToken: string, actor: TelegramStartActor): Promise<void> {
    const prepared = await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      async (client) => {
        const result = await client.query<RegistrationRow>(
          // Повторный Start по той же ссылке допустим и перевыпускает код:
          // первая доставка могла не дойти. Завершённую заявку не трогаем.
          `
            SELECT ${REGISTRATION_COLUMNS}
            FROM registration_requests
            WHERE start_token_hash = $1
              AND status IN ('pending', 'code_sent')
              AND expires_at > now()
            LIMIT 1
          `,
          [hashStartToken(startToken)],
        );

        if (result.rowCount === 0) {
          return null;
        }

        const request = result.rows[0];
        const actorUsername = actor.username?.trim().toLowerCase() ?? "";

        if (actorUsername !== request.telegram_username) {
          this.logger.warn(
            `Registration ${request.id} start command came from @${
              actorUsername || "unknown"
            }, expected @${request.telegram_username}; ignoring.`,
          );

          return { mismatch: true as const, request };
        }

        const code = generateCode();
        const codeExpiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
        const displayName = buildDisplayName(actor, request.telegram_username);

        await client.query(
          `
            UPDATE registration_requests
            SET telegram_id = $2,
                display_name = $3,
                code_hash = $4,
                code_expires_at = $5::timestamptz,
                status = 'code_sent',
                attempt_count = 0,
                locked_until = NULL,
                delivery_note = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [
            request.id,
            String(actor.id),
            displayName,
            hashRegistrationCode(request.id, code),
            codeExpiresAt.toISOString(),
          ],
        );

        return {
          code,
          codeExpiresAt: codeExpiresAt.toISOString(),
          mismatch: false as const,
          request,
        };
      },
      { isPlatformOperator: true },
    );

    if (!prepared) {
      this.logger.warn("Received /start with an unknown or expired registration token.");

      return;
    }

    if (prepared.mismatch) {
      return;
    }

    const delivery = await this.telegram.deliver({
      code: prepared.code,
      expiresAt: prepared.codeExpiresAt,
      purpose: REGISTRATION_PURPOSE,
      requestId: prepared.request.id,
      telegramId: String(actor.id),
      telegramUsername: prepared.request.telegram_username,
      userId: prepared.request.id,
    });

    if (!delivery.delivered) {
      await this.recordDeliveryNote(prepared.request.id, delivery.note ?? "telegram_delivery_failed");
    }
  }

  async getStatus(requestId: string): Promise<RegistrationStatusResponseDto> {
    const request = await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      (client) => this.findById(client, requestId),
      { isPlatformOperator: true },
    );

    if (!request) {
      throw notFound(requestId);
    }

    return {
      codeExpiresAt: nullableIso(request.code_expires_at),
      expiresAt: toIso(request.expires_at),
      note: request.delivery_note,
      requestId: request.id,
      status: request.status,
    };
  }

  async verifyRegistration(
    payload: RegistrationVerifyDto,
    meta: RegistrationRequestMeta = {},
  ): Promise<Record<string, unknown>> {
    this.assertRateLimit(this.verifyRateLimiter, [
      `registration:verify:request:${payload.requestId}`,
      meta.ip ? `registration:verify:ip:${meta.ip}` : "",
    ]);

    // Заявку читаем в отдельной транзакции: withTenant откатывается на throw, а
    // учёт попыток и блокировка обязаны пережить отклонённый запрос.
    const request = await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      (client) => this.findById(client, payload.requestId),
      { isPlatformOperator: true },
    );

    if (!request) {
      throw invalidCode("Registration request is unknown.");
    }

    const now = new Date();

    if (request.status === "completed") {
      throw invalidCode("Registration request has already been completed.");
    }

    if (new Date(request.expires_at).getTime() <= now.getTime()) {
      throw invalidCode("Registration request has expired.");
    }

    if (request.status !== "code_sent" || !request.code_hash) {
      throw new HttpException(
        {
          code: "REGISTRATION_CODE_NOT_SENT",
          description: "Registration code has not been delivered yet.",
          humanMessage: "Код ещё не отправлен: откройте бота и нажмите Start.",
        },
        HttpStatus.CONFLICT,
      );
    }

    if (request.locked_until && new Date(request.locked_until).getTime() > now.getTime()) {
      throw tooManyRequests(
        "Registration code is locked after too many attempts.",
        Math.ceil((new Date(request.locked_until).getTime() - now.getTime()) / 1000),
      );
    }

    if (
      request.code_expires_at &&
      new Date(request.code_expires_at).getTime() <= now.getTime()
    ) {
      throw invalidCode("Registration code has expired.");
    }

    if (!secureEqual(hashRegistrationCode(request.id, payload.code), request.code_hash)) {
      const nextAttemptCount = request.attempt_count + 1;
      const lockedUntil =
        nextAttemptCount >= MAX_VERIFY_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_SECONDS * 1000).toISOString()
          : null;

      await this.commitAttemptFailure(request, nextAttemptCount, lockedUntil, meta);

      if (lockedUntil) {
        throw tooManyRequests("Registration code is locked after too many attempts.", LOCKOUT_SECONDS);
      }

      throw invalidCode("Registration code is invalid.");
    }

    return this.completeRegistration(request, meta);
  }

  /**
   * Создаёт организацию, администратора и сессию одной транзакцией и помечает
   * заявку завершённой. До этого момента организации в БД не существует.
   */
  private async completeRegistration(
    request: RegistrationRow,
    meta: RegistrationRequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      async (client) => {
        const user = await this.createOrganizationWithAdministrator(client, request);

        // Заявка закрывается последней: organization_id обязан быть непустым по
        // CHECK-констрейнту, поэтому ссылка появляется только после вставки
        // организации. Условие status = 'code_sent' здесь же служит защитой от
        // гонки — параллельная транзакция дождётся блокировки строки, увидит
        // 'completed' и откатится вместе со своей организацией.
        const consumed = await client.query<{ id: string }>(
          `
            UPDATE registration_requests
            SET status = 'completed',
                completed_at = now(),
                organization_id = $2,
                code_hash = NULL,
                code_expires_at = NULL,
                updated_at = now()
            WHERE id = $1 AND status = 'code_sent'
            RETURNING id
          `,
          [request.id, user.organizationId],
        );

        if (consumed.rowCount === 0) {
          throw invalidCode("Registration request has already been completed.");
        }

        const session = await this.createSession(client, user, meta);

        await this.audit.record(client, {
          action: AUDIT_ACTIONS.registerSuccess,
          actorUserId: user.id,
          ip: meta.ip ?? null,
          metadata: {
            authMethod: "telegram",
            registrationRequestId: request.id,
            roleCodes: ["administrator"],
            sessionExpiresAt: session.expiresAt,
          },
          objectId: user.organizationId,
          objectType: "organization",
          organizationId: user.organizationId,
          requestId: request.id,
        });

        return buildSessionResponse(user, session);
      },
      { isPlatformOperator: true },
    );
  }

  private async createOrganizationWithAdministrator(
    client: Queryable,
    request: RegistrationRow,
  ): Promise<CreatedUserRecord> {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const displayName = request.display_name?.trim() || `@${request.telegram_username}`;

    const organization = await client.query<{ name: string; status: string }>(
      `
        INSERT INTO organizations (id, name, status, created_at, updated_at)
        VALUES ($1, $2, 'active', now(), now())
        RETURNING name, status
      `,
      [organizationId, request.organization_name],
    );

    const role = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE code = 'administrator' LIMIT 1",
    );
    if (role.rowCount === 0) {
      throw new HttpException(
        {
          code: "ROLE_UNKNOWN",
          description: "Role administrator does not exist.",
          humanMessage: "Роль администратора не настроена.",
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await client.query(
      `
        INSERT INTO users (
          id,
          organization_id,
          telegram_username,
          telegram_id,
          email,
          display_name,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), now())
      `,
      [
        userId,
        organizationId,
        request.telegram_username,
        request.telegram_id,
        request.email,
        displayName,
      ],
    );

    await client.query(
      "INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1, $2, $3)",
      [userId, role.rows[0].id, organizationId],
    );

    return {
      displayName,
      email: request.email,
      id: userId,
      organizationId,
      organizationName: organization.rows[0].name,
      organizationStatus: organization.rows[0].status,
      telegramUsername: request.telegram_username,
    };
  }

  private async createSession(
    client: Queryable,
    user: CreatedUserRecord,
    meta: RegistrationRequestMeta,
  ): Promise<{ expiresAt: string; id: string; issuedAt: string; token: string }> {
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
        user.id,
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

  private async commitAttemptFailure(
    request: RegistrationRow,
    nextAttemptCount: number,
    lockedUntil: null | string,
    meta: RegistrationRequestMeta,
  ): Promise<void> {
    await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      (client) =>
        client.query(
          `
            UPDATE registration_requests
            SET attempt_count = $2,
                locked_until = $3::timestamptz,
                updated_at = now()
            WHERE id = $1
          `,
          [request.id, nextAttemptCount, lockedUntil],
        ),
      { isPlatformOperator: true },
    );

    this.logger.warn(
      `Registration ${request.id} code attempt ${nextAttemptCount} failed from ip ${
        meta.ip ?? "unknown"
      }${lockedUntil ? `; locked until ${lockedUntil}` : ""}.`,
    );
  }

  private async recordDeliveryNote(requestId: string, note: string): Promise<void> {
    await this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      (client) =>
        client.query(
          "UPDATE registration_requests SET delivery_note = $2, updated_at = now() WHERE id = $1",
          [requestId, note],
        ),
      { isPlatformOperator: true },
    );
  }

  private async findById(client: Queryable, id: string): Promise<null | RegistrationRow> {
    const result = await client.query<RegistrationRow>(
      `SELECT ${REGISTRATION_COLUMNS} FROM registration_requests WHERE id = $1 LIMIT 1`,
      [id],
    );

    return result.rowCount === 0 ? null : result.rows[0];
  }

  /** Незавершённые заявки старше суток удаляются; завершённые остаются как след. */
  private async purgeExpired(client: Queryable): Promise<void> {
    await client.query(
      "DELETE FROM registration_requests WHERE status <> 'completed' AND expires_at <= now()",
    );
  }

  private assertRateLimit(limiter: TelegramLoginRateLimiter, keys: string[]): void {
    const decision = requireTelegramLoginRateLimit(limiter, keys);

    if (!decision.allowed) {
      throw tooManyRequests(
        "Too many registration attempts. Try again later.",
        decision.retryAfterSeconds,
      );
    }
  }
}

const REGISTRATION_COLUMNS = `
  id,
  telegram_username,
  email,
  organization_name,
  display_name,
  telegram_id,
  code_hash,
  code_expires_at,
  delivery_note,
  status,
  attempt_count,
  locked_until,
  expires_at
`;

function buildDisplayName(actor: TelegramStartActor, fallbackUsername: string): string {
  const parts = [actor.firstName?.trim(), actor.lastName?.trim()].filter(
    (part): part is string => Boolean(part),
  );

  return parts.length > 0 ? parts.join(" ") : `@${fallbackUsername}`;
}

function buildSessionResponse(
  user: CreatedUserRecord,
  session: { expiresAt: string; id: string; issuedAt: string; token: string },
): Record<string, unknown> {
  const roles = ["administrator"] as const;

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
    organizationId: user.organizationId,
    roleBindings: roles.map((role) => ({ organizationId: user.organizationId, role })),
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
      id: user.id,
      organizationId: user.organizationId,
      role: primaryRole([...roles]),
      status: "active",
      telegramUsername: user.telegramUsername,
    },
  };
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function createStartToken(): string {
  // Payload deep-link ограничен 64 символами и алфавитом A-Za-z0-9_-.
  return `brr_${randomBytes(32).toString("base64url")}`;
}

function createSessionToken(): string {
  return `brs_${randomBytes(32).toString("base64url")}`;
}

function hashStartToken(token: string): string {
  return hmac(`registration_start:server:${token}`);
}

function hashRegistrationCode(requestId: string, code: string): string {
  return hmac(`registration_code:${requestId}:${code}`);
}

function hmac(payload: string): string {
  const secret = process.env[AUTH_HASH_SECRET_ENV] ?? DEFAULT_AUTH_HASH_SECRET;

  return `sha256:${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function invalidCode(description: string): HttpException {
  return new HttpException(
    {
      code: "REGISTRATION_INVALID",
      description,
      humanMessage: "Код подтверждения регистрации недействителен.",
    },
    HttpStatus.UNAUTHORIZED,
  );
}

function notFound(requestId: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `registration_request ${requestId} was not found`,
    humanMessage: "Заявка на регистрацию не найдена.",
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

function nullableIso(value: Date | string | null): null | string {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
